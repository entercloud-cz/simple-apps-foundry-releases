// saf:access-contract-test
//
// The contract test of the default access policy (src/App/Auth/AccessPolicy.cs). It walks every
// registered /api endpoint and checks who gets in, by level:
//   - not signed in: 401 everywhere but Public routes;
//   - a user without a role (or only with roles that give no level): 403 everywhere but User and Public routes;
//   - Reader (read): refused on every write and admin route;
//   - Editor (write): refused on every admin route;
//   - Admin: let through everywhere.
// A route's level is its own WithAccess(...) or [Access(...)], else the default below (the policy's
// table, written again here so that a change to the policy fails this test). Never skip or weaken
// this test: `platform check` (PC066) looks for it, and the delivery pipeline runs it.

using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;
using App.Auth;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace App.Tests;

public sealed partial class AccessContractTests(TestAppFactory factory) : IClassFixture<TestAppFactory>
{
    private sealed record ApiRoute(string Method, string Pattern, Access? Declared);

    // null: not signed in. Guest has no level and Stranger is not in the roles file: neither gives access.
    private static readonly (string Who, string[]? Roles)[] People =
    [
        ("anonymous", null),
        ("no role", ["Guest", "Stranger"]),
        ("Reader", ["Reader"]),
        ("Editor", ["Editor"]),
        ("Admin", ["Admin"]),
    ];

    /// <summary>Who the policy lets through for each access, by the table in ADR-0078.</summary>
    private static readonly Dictionary<Access, string[]> LetThrough = new()
    {
        [Access.Public] = ["anonymous", "no role", "Reader", "Editor", "Admin"],
        [Access.User] = ["no role", "Reader", "Editor", "Admin"],
        [Access.Read] = ["Reader", "Editor", "Admin"],
        [Access.Write] = ["Editor", "Admin"],
        [Access.Admin] = ["Admin"],
    };

    private static Access DefaultAccess(string method, string pattern)
    {
        if (AdminPath().IsMatch(pattern)) return Access.Admin;
        return method is "GET" or "HEAD" ? Access.Read : Access.Write;
    }

    [GeneratedRegex("^/api/(admin|settings)(/|$)", RegexOptions.IgnoreCase)]
    private static partial Regex AdminPath();

    [GeneratedRegex(@"\{[^}]+\}")]
    private static partial Regex RouteParameter();

    /// <summary>Every /api endpoint and method. An endpoint without methods answers any: GET and POST are tried.</summary>
    private List<ApiRoute> ApiRoutes() =>
        factory.Services.GetRequiredService<EndpointDataSource>().Endpoints
            .OfType<RouteEndpoint>()
            .Where(e => AccessPolicy.IsApiPath(e.RoutePattern.RawText))
            .SelectMany(e => (e.Metadata.GetMetadata<IHttpMethodMetadata>()?.HttpMethods ?? ["GET", "POST"])
                .Select(method => new ApiRoute(method, e.RoutePattern.RawText!, e.Metadata.GetMetadata<AccessAttribute>()?.Access)))
            .ToList();

    /// <summary>A refusal by the policy, not by a stricter rule of the route itself (RequireRole).</summary>
    private static async Task<bool> RefusedByPolicy(HttpResponseMessage response, CancellationToken ct)
    {
        if (response.StatusCode == HttpStatusCode.Unauthorized) return true;
        if (response.StatusCode != HttpStatusCode.Forbidden) return false;
        var body = await response.Content.ReadFromJsonAsync<JsonElement>(ct);
        return body.TryGetProperty("error", out var error) && error.GetString() == AccessPolicy.RefusedMessage;
    }

    [Fact]
    public void SeesTheRoutes()
    {
        var routes = ApiRoutes();
        Assert.NotEmpty(routes);
        Assert.Contains(new ApiRoute("GET", "/api/me", Access.User), routes);
    }

    [Fact]
    public async Task PolicyHoldsForEveryApiRouteAndLevel()
    {
        var ct = TestContext.Current.CancellationToken;
        var client = factory.CreateClient();
        var failures = new List<string>();
        foreach (var route in ApiRoutes())
        {
            var access = route.Declared ?? DefaultAccess(route.Method, route.Pattern);
            var path = RouteParameter().Replace(route.Pattern, "1");
            foreach (var (who, roles) in People)
            {
                using var request = new HttpRequestMessage(new HttpMethod(route.Method), path);
                // An empty JSON object for a write: the policy comes first; the route's own validation may then say 400.
                if (route.Method is not ("GET" or "HEAD")) request.Content = JsonContent.Create(new { });
                if (roles is not null) request.Headers.Add(ClientPrincipal.HeaderName, TestAppFactory.PrincipalHeader(roles));
                using var response = await client.SendAsync(request, ct);
                var where = $"{route.Method} {route.Pattern} ({access})";
                if (LetThrough[access].Contains(who))
                {
                    if (await RefusedByPolicy(response, ct)) failures.Add($"{where}: {who} was refused with {(int)response.StatusCode}");
                }
                else
                {
                    var expected = who == "anonymous" ? HttpStatusCode.Unauthorized : HttpStatusCode.Forbidden;
                    if (response.StatusCode != expected) failures.Add($"{where}: {who} got {(int)response.StatusCode}, not {(int)expected}");
                }
            }
        }
        Assert.Empty(failures);
    }
}
