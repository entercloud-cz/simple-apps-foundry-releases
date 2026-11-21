using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using App.Auth;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

namespace App.Tests;

public sealed class AppTests(WebApplicationFactory<Program> factory) : IClassFixture<WebApplicationFactory<Program>>
{
    private static string PrincipalHeader(params string[] roles)
    {
        var claims = new List<object>
        {
            new { typ = "http://schemas.microsoft.com/identity/claims/objectidentifier", val = "11111111-1111-1111-1111-111111111111" },
            new { typ = "name", val = "Test User" },
            new { typ = "preferred_username", val = "test@contoso.com" },
        };
        claims.AddRange(roles.Select(r => new { typ = "roles", val = r }));
        var json = JsonSerializer.Serialize(new { auth_typ = "aad", claims });
        return Convert.ToBase64String(Encoding.UTF8.GetBytes(json));
    }

    private HttpClient Client(params string[] roles)
    {
        var client = factory.CreateClient();
        if (roles.Length > 0) client.DefaultRequestHeaders.Add(ClientPrincipal.HeaderName, PrincipalHeader(roles));
        return client;
    }

    [Fact]
    public async Task HealthEndpointsAnswer()
    {
        var client = Client();
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/healthz", TestContext.Current.CancellationToken)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/readyz", TestContext.Current.CancellationToken)).StatusCode);
    }

    [Fact]
    public async Task SignInAndRolesAreEnforced()
    {
        var ct = TestContext.Current.CancellationToken;
        Assert.Equal(HttpStatusCode.Unauthorized, (await Client().GetAsync("/api/me", ct)).StatusCode);

        var me = await Client("Reader").GetFromJsonAsync<JsonElement>("/api/me", ct);
        Assert.Equal("Test User", me.GetProperty("name").GetString());

        Assert.Equal(HttpStatusCode.Forbidden, (await Client("Reader").GetAsync("/api/admin/ping", ct)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await Client("Admin").GetAsync("/api/admin/ping", ct)).StatusCode);
    }

    [Fact]
    public async Task InputIsValidated()
    {
        var ct = TestContext.Current.CancellationToken;
        var bad = await Client("Reader").PostAsJsonAsync("/api/echo", new { message = "" }, ct);
        var good = await Client("Reader").PostAsJsonAsync("/api/echo", new { message = "hi" }, ct);
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        Assert.Equal(HttpStatusCode.OK, good.StatusCode);
        Assert.Contains("default-src 'self'", good.Headers.GetValues("Content-Security-Policy").Single());
    }

    [Fact]
    public void MalformedPrincipalIsIgnored()
    {
        Assert.Null(ClientPrincipal.Parse("not-base64!"));
        Assert.Null(ClientPrincipal.Parse(null));
    }
}
