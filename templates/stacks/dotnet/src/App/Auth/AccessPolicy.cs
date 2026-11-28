// saf:access-policy
//
// The app's default access policy, on every /api route, deny by default:
//
//   GET, HEAD                                  needs the level read
//   POST, PUT, PATCH, DELETE (any other)       needs write
//   /api/admin/**, /api/settings/** (any)      needs admin
//   signed in, but no role with a level        refused (403)
//   not signed in                              401
//
// Program.cs runs it for every request (app.UseAccessPolicy()), whatever an endpoint's own
// authorization says, so an endpoint can't slip past it by mapping or [AllowAnonymous]. A route
// says otherwise only on its own declaration, so a reviewer sees every exception:
//
//   api.MapGet("/me", ...).WithAccess(Access.User);        // any signed-in user, even without a role
//   api.MapPost("/search", ...).WithAccess(Access.Read);   // a read sent as POST
//   [Access(Access.User)] on a handler method does the same.
//
//   Read, Write, Admin   that level
//   User                 any signed-in user, whatever their roles
//   Public               no sign-in at all: only an anonymous app or a deliberately public endpoint
//
// Never weaken or remove this policy; declare an exception on its route only with the user's OK and
// record it in docs/architecture.md. tests/App.Tests/AccessContractTests.cs checks every route
// against it. RequireAuthorization(p => p.RequireRole("Admin")) still works on top of it, for finer rules.

using Microsoft.AspNetCore.Authentication;

namespace App.Auth;

/// <summary>Who may call a route: a level, any signed-in user, or anyone.</summary>
public enum Access
{
    Read,
    Write,
    Admin,
    User,
    Public,
}

/// <summary>Declares who may call this route instead of the default policy.</summary>
[AttributeUsage(AttributeTargets.Method | AttributeTargets.Class, AllowMultiple = false)]
public sealed class AccessAttribute(Access access) : Attribute
{
    public Access Access { get; } = access;
}

public static class AccessPolicy
{
    /// <summary>The 403 body's message when this policy refuses a request (tests tell it from other 403s).</summary>
    public const string RefusedMessage = "Your role in this app does not allow this";

    private static readonly string[] AdminPrefixes = ["/api/admin", "/api/settings"];

    /// <summary>Declares who may call this route instead of the default policy.</summary>
    public static TBuilder WithAccess<TBuilder>(this TBuilder builder, Access access)
        where TBuilder : IEndpointConventionBuilder => builder.WithMetadata(new AccessAttribute(access));

    public static bool IsApiPath(string? path) => Under(Normalize(path), "/api");

    /// <summary>What a request needs: the route's declared access, else the default for its method and path.</summary>
    public static Access Required(string method, IEnumerable<string?> paths, Access? declared)
    {
        if (declared is { } access) return access;
        if (paths.Select(Normalize).Any(p => AdminPrefixes.Any(prefix => Under(p, prefix)))) return Access.Admin;
        return HttpMethods.IsGet(method) || HttpMethods.IsHead(method) ? Access.Read : Access.Write;
    }

    /// <summary>Installs the policy. Call it right after UseAuthentication() (it needs the user).</summary>
    public static IApplicationBuilder UseAccessPolicy(this IApplicationBuilder app) => app.Use(async (context, next) =>
    {
        // The matched endpoint's pattern and the path the client sent: either one under /api puts
        // the request under the policy (an unknown /api path too).
        var endpoint = context.GetEndpoint();
        string?[] paths = [(endpoint as RouteEndpoint)?.RoutePattern.RawText, context.Request.Path.Value];
        if (!paths.Any(IsApiPath))
        {
            await next(context);
            return;
        }

        var needed = Required(context.Request.Method, paths, endpoint?.Metadata.GetMetadata<AccessAttribute>()?.Access);
        if (needed != Access.Public)
        {
            if (context.User.Identity?.IsAuthenticated != true)
            {
                await context.ChallengeAsync(); // 401 (EasyAuthHandler)
                return;
            }
            if (needed != Access.User)
            {
                var level = context.RequestServices.GetRequiredService<AppRoles>().LevelOf(context.User);
                if (!AppRoles.Allows(level, ToLevel(needed)))
                {
                    context.Response.StatusCode = StatusCodes.Status403Forbidden;
                    await context.Response.WriteAsJsonAsync(new { error = RefusedMessage });
                    return;
                }
            }
        }
        await next(context);
    });

    private static RoleLevel ToLevel(Access access) => access switch
    {
        Access.Read => RoleLevel.Read,
        Access.Write => RoleLevel.Write,
        _ => RoleLevel.Admin,
    };

    /// <summary>The path for checks only: repeated slashes collapsed (case is ignored by the comparisons).</summary>
    private static string Normalize(string? path)
    {
        var result = path ?? "";
        while (result.Contains("//", StringComparison.Ordinal)) result = result.Replace("//", "/", StringComparison.Ordinal);
        return result;
    }

    private static bool Under(string path, string prefix) =>
        path.Equals(prefix, StringComparison.OrdinalIgnoreCase) ||
        path.StartsWith(prefix + "/", StringComparison.OrdinalIgnoreCase);
}
