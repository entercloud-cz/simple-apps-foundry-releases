using System.Security.Claims;
using App;
using App.Auth;
using Azure.Monitor.OpenTelemetry.AspNetCore;
using Microsoft.AspNetCore.HttpLogging;

var builder = WebApplication.CreateBuilder(args);
var config = builder.Configuration; // includes environment variables

// ---- Configuration: environment variables only (app contract) ----
var onAzure = !string.IsNullOrEmpty(config["CONTAINER_APP_NAME"]); // set by Azure Container Apps
var devUser = ClientPrincipal.DevUser(config["DEV_FAKE_USER"], config["DEV_FAKE_ROLES"]);
if (onAzure && devUser is not null)
    throw new InvalidOperationException("DEV_FAKE_USER/DEV_FAKE_ROLES must not be set on Azure");
var port = int.TryParse(config["PORT"], out var p) ? p : 8080;
var frontDoorId = config["FRONT_DOOR_ID"];

builder.WebHost.UseUrls($"http://0.0.0.0:{port}");
builder.Host.ConfigureHostOptions(o => o.ShutdownTimeout = TimeSpan.FromSeconds(25)); // platform waits ~30 s after SIGTERM

// ---- JSON logs to stdout ----
builder.Logging.ClearProviders();
builder.Logging.AddJsonConsole(o =>
{
    o.UseUtcTimestamp = true;
    o.TimestampFormat = "yyyy-MM-ddTHH:mm:ss.fffZ";
});

// One log line per request (method, path, status, duration); health probes excluded below.
builder.Services.AddHttpLogging(o =>
{
    o.LoggingFields = HttpLoggingFields.RequestMethod | HttpLoggingFields.RequestPath |
                      HttpLoggingFields.ResponseStatusCode | HttpLoggingFields.Duration;
    o.CombineLogs = true;
});

// ---- Application Insights (OpenTelemetry); reads APPLICATIONINSIGHTS_CONNECTION_STRING ----
if (!string.IsNullOrEmpty(config["APPLICATIONINSIGHTS_CONNECTION_STRING"]))
{
    builder.Services.AddOpenTelemetry().UseAzureMonitor();
}

// ---- Sign-in (platform header) and roles ----
builder.Services.AddAuthentication(EasyAuthHandler.SchemeName)
    .AddScheme<EasyAuthOptions, EasyAuthHandler>(EasyAuthHandler.SchemeName, o => o.DevUser = devUser);
builder.Services.AddAuthorization();

// Readiness checks: add one per dependency the app needs (e.g. AddNpgSql/AddSqlServer packages).
builder.Services.AddHealthChecks();
builder.Services.AddProblemDetails();
builder.Services.AddValidation(); // validates [Required], [StringLength], … on API inputs (400 on failure)

var app = builder.Build();

app.UseExceptionHandler(); // generic 500 without stack traces
app.UseHttpLogging();

// Behind Azure Front Door the platform sets FRONT_DOOR_ID: reject requests that did not come
// through it. Health probes come from the platform directly and are exempt.
string[] healthPaths = ["/healthz", "/readyz"];
app.Use(async (context, next) =>
{
    if (!string.IsNullOrEmpty(frontDoorId) && !healthPaths.Contains(context.Request.Path.Value))
    {
        var ids = context.Request.Headers["X-Azure-FDID"].ToString().Split(',', StringSplitOptions.TrimEntries);
        if (!ids.Contains(frontDoorId, StringComparer.OrdinalIgnoreCase))
        {
            app.Logger.LogWarning("Request rejected: missing or wrong X-Azure-FDID");
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return;
        }
    }
    var headers = context.Response.Headers;
    headers.ContentSecurityPolicy = "default-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
    headers.XContentTypeOptions = "nosniff";
    headers["Referrer-Policy"] = "no-referrer";
    headers.StrictTransportSecurity = "max-age=31536000; includeSubDomains";
    await next();
});

app.UseAuthentication();
app.UseAuthorization();

// Liveness: never check databases or other services here.
app.MapGet("/healthz", () => Results.Ok(new { status = "ok" })).WithHttpLogging(HttpLoggingFields.None);
// Readiness: runs the registered health checks.
app.MapHealthChecks("/readyz").WithHttpLogging(HttpLoggingFields.None);

var api = app.MapGroup("/api").RequireAuthorization();

api.MapGet("/me", (ClaimsPrincipal user) => new
{
    name = user.Identity?.Name,
    email = user.FindFirstValue(ClaimTypes.Email),
    roles = user.FindAll(ClaimTypes.Role).Select(c => c.Value),
});

api.MapGet("/admin/ping", () => new { message = "pong (only users with the Admin role can see this)" })
    .RequireAuthorization(policy => policy.RequireRole("Admin"));

api.MapPost("/echo", (EchoRequest body) => new { message = body.Message });

app.Run();

public partial class Program;
