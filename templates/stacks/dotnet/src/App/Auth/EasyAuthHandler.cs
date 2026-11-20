using System.Security.Claims;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;

namespace App.Auth;

public sealed class EasyAuthOptions : AuthenticationSchemeOptions
{
    /// <summary>Local development mock user (DEV_FAKE_USER). Never set on Azure.</summary>
    public ClaimsPrincipal? DevUser { get; set; }
}

/// <summary>
/// Turns the platform's X-MS-CLIENT-PRINCIPAL header into the request's user, so the
/// standard [Authorize], RequireAuthorization() and RequireRole("Admin") work.
/// </summary>
public sealed class EasyAuthHandler(
    IOptionsMonitor<EasyAuthOptions> options, ILoggerFactory logger, UrlEncoder encoder)
    : AuthenticationHandler<EasyAuthOptions>(options, logger, encoder)
{
    public const string SchemeName = "EasyAuth";

    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var principal = ClientPrincipal.Parse(Request.Headers[ClientPrincipal.HeaderName]) ?? Options.DevUser;
        return Task.FromResult(principal is null
            ? AuthenticateResult.NoResult()
            : AuthenticateResult.Success(new AuthenticationTicket(principal, SchemeName)));
    }

    protected override async Task HandleChallengeAsync(AuthenticationProperties properties)
    {
        Response.StatusCode = StatusCodes.Status401Unauthorized;
        await Response.WriteAsJsonAsync(new { error = "Sign-in required" });
    }

    protected override async Task HandleForbiddenAsync(AuthenticationProperties properties)
    {
        Response.StatusCode = StatusCodes.Status403Forbidden;
        await Response.WriteAsJsonAsync(new { error = "You do not have permission to do this" });
    }
}
