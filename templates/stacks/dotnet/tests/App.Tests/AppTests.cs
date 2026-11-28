using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using App.Auth;
using Xunit;

namespace App.Tests;

public sealed class AppTests(TestAppFactory factory) : IClassFixture<TestAppFactory>
{
    [Fact]
    public async Task HealthEndpointsAnswer()
    {
        var client = factory.Client();
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/healthz", TestContext.Current.CancellationToken)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/readyz", TestContext.Current.CancellationToken)).StatusCode);
    }

    [Fact]
    public async Task SignInAndRolesAreEnforced()
    {
        var ct = TestContext.Current.CancellationToken;
        Assert.Equal(HttpStatusCode.Unauthorized, (await factory.Client().GetAsync("/api/me", ct)).StatusCode);

        var me = await factory.Client("Reader", "Guest", "Stranger").GetFromJsonAsync<JsonElement>("/api/me", ct);
        Assert.Equal("11111111-1111-1111-1111-111111111111", me.GetProperty("id").GetString());
        Assert.Equal("Test User", me.GetProperty("name").GetString());
        Assert.Equal("test@contoso.com", me.GetProperty("email").GetString());
        Assert.Equal("read", me.GetProperty("level").GetString());
        Assert.False(me.GetProperty("isDevUser").GetBoolean());
        var roles = me.GetProperty("roles").EnumerateArray().ToList();
        Assert.Equal("Reader, Guest", string.Join(", ", roles.Select(r => r.GetProperty("value").GetString())));
        Assert.Equal("Can see the data.", roles[0].GetProperty("description").GetString());
        Assert.Equal(JsonValueKind.Null, roles[1].GetProperty("level").ValueKind);

        Assert.Equal(HttpStatusCode.Forbidden, (await factory.Client("Reader").GetAsync("/api/admin/ping", ct)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await factory.Client("Admin").GetAsync("/api/admin/ping", ct)).StatusCode);
    }

    [Fact]
    public async Task MeAnswersAUserWithoutARole()
    {
        var ct = TestContext.Current.CancellationToken;
        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/me");
        request.Headers.Add(ClientPrincipal.HeaderName, TestAppFactory.PrincipalHeader());
        using var response = await factory.CreateClient().SendAsync(request, ct);
        var me = await response.Content.ReadFromJsonAsync<JsonElement>(ct);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Empty(me.GetProperty("roles").EnumerateArray());
        Assert.Equal(JsonValueKind.Null, me.GetProperty("level").ValueKind);
    }

    [Fact]
    public async Task InputIsValidated()
    {
        var ct = TestContext.Current.CancellationToken;
        var bad = await factory.Client("Editor").PostAsJsonAsync("/api/echo", new { message = "" }, ct);
        var good = await factory.Client("Editor").PostAsJsonAsync("/api/echo", new { message = "hi" }, ct);
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        Assert.Equal(HttpStatusCode.OK, good.StatusCode);
        Assert.Contains("default-src 'self'", good.Headers.GetValues("Content-Security-Policy").Single());
    }

    [Fact]
    public async Task StartPageShowsTheUserMenu()
    {
        var ct = TestContext.Current.CancellationToken;
        var client = factory.Client();
        var page = await client.GetStringAsync("/", ct);
        Assert.Contains("/.auth/logout?post_logout_redirect_uri=/", page, StringComparison.Ordinal);
        Assert.Contains("/.auth/login/aad?prompt=select_account&amp;post_login_redirect_uri=/", page, StringComparison.Ordinal);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/static/app.js", ct)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/static/styles.css", ct)).StatusCode);
    }

    [Fact]
    public void MalformedPrincipalIsIgnored()
    {
        Assert.Null(ClientPrincipal.Parse("not-base64!"));
        Assert.Null(ClientPrincipal.Parse(null));
    }

    [Fact]
    public void RolesFileIsRead()
    {
        var roles = AppRoles.Parse("""
            {"signIn": true, "roles": [
              {"value": "Viewer", "displayName": "Viewer", "description": "Sees reports.", "level": "read"},
              {"value": "Approver", "level": "owner"},
              {"value": "Clerk"}
            ]}
            """);
        RoleDefinition[] expected =
        [
            new("Viewer", "Viewer", "Sees reports.", RoleLevel.Read),
            new("Approver", "Approver", "", null),
            new("Clerk", "Clerk", "", null),
        ];
        Assert.Equal(expected, roles.Roles);
        Assert.Throws<RolesFileException>(() => AppRoles.Parse("not json"));
        Assert.Throws<RolesFileException>(() => AppRoles.Parse("""{"roles": [{"level": "read"}]}"""));
        Assert.Same(AppRoles.Defaults, AppRoles.Load(Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString(), "roles.json")));
    }

    [Fact]
    public void LevelsNestAndDefaultsFollowMethodAndPath()
    {
        Assert.True(AppRoles.Allows(RoleLevel.Admin, RoleLevel.Read));
        Assert.True(AppRoles.Allows(RoleLevel.Write, RoleLevel.Read));
        Assert.False(AppRoles.Allows(RoleLevel.Read, RoleLevel.Write));
        Assert.False(AppRoles.Allows(RoleLevel.Write, RoleLevel.Admin));
        Assert.False(AppRoles.Allows(null, RoleLevel.Read));

        Assert.Equal(Access.Read, AccessPolicy.Required("GET", ["/api/items"], null));
        Assert.Equal(Access.Read, AccessPolicy.Required("HEAD", ["/api/items"], null));
        Assert.Equal(Access.Write, AccessPolicy.Required("DELETE", ["/api/items/1"], null));
        Assert.Equal(Access.Write, AccessPolicy.Required("OPTIONS", ["/api/items"], null));
        Assert.Equal(Access.Admin, AccessPolicy.Required("GET", ["/api/settings"], null));
        Assert.Equal(Access.Admin, AccessPolicy.Required("GET", ["/api/items", "/api//Admin/x"], null));
        Assert.Equal(Access.Read, AccessPolicy.Required("POST", ["/api/search"], Access.Read));
    }
}
