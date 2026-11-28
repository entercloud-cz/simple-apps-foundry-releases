using System.Text;
using System.Text.Json;
using App.Auth;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;

namespace App.Tests;

/// <summary>The app with the test roles, whatever .platform/roles.json says.</summary>
public sealed class TestAppFactory : WebApplicationFactory<Program>
{
    /// <summary>
    /// One role per level, and one without a level (it gives no access). The tests check the policy
    /// by level, not the app's role names.
    /// </summary>
    public static AppRoles Roles { get; } = new(true,
    [
        new("Reader", "Reader", "Can see the data.", RoleLevel.Read),
        new("Editor", "Editor", "Can change the data.", RoleLevel.Write),
        new("Admin", "Admin", "Can change the settings.", RoleLevel.Admin),
        new("Guest", "Guest", "Has no level yet.", null),
    ]);

    protected override void ConfigureWebHost(IWebHostBuilder builder) =>
        builder.ConfigureTestServices(services => services.AddSingleton(Roles));

    /// <summary>A client signed in with these app roles; no roles at all: not signed in.</summary>
    public HttpClient Client(params string[] roles)
    {
        var client = CreateClient();
        if (roles.Length > 0) client.DefaultRequestHeaders.Add(ClientPrincipal.HeaderName, PrincipalHeader(roles));
        return client;
    }

    /// <summary>An X-MS-CLIENT-PRINCIPAL header value like the platform's sign-in sends.</summary>
    public static string PrincipalHeader(params string[] roles)
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
}
