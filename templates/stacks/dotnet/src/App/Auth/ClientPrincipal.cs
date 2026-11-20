// Reads the signed-in user from the X-MS-CLIENT-PRINCIPAL header.
//
// The platform's sign-in (Azure Container Apps built-in authentication, "Easy Auth")
// signs users in with Microsoft Entra ID before a request reaches the app, and adds
// this header: base64-encoded JSON with the user's claims. Never implement your own
// login. Locally there is no Easy Auth: use DEV_FAKE_USER / DEV_FAKE_ROLES instead.
//
// This file has no ASP.NET dependencies so it can be copied into any .NET app.

using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace App.Auth;

public static class ClientPrincipal
{
    public const string HeaderName = "X-MS-CLIENT-PRINCIPAL";
    public const string AuthenticationType = "EasyAuth";

    private static readonly string[] ObjectIdTypes =
        ["http://schemas.microsoft.com/identity/claims/objectidentifier", "oid"];
    private static readonly string[] RoleTypes =
        ["roles", "http://schemas.microsoft.com/ws/2008/06/identity/claims/role"];
    private static readonly string[] EmailTypes =
    [
        "preferred_username", "email", "upn",
        "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn",
        "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
    ];

    private sealed record Claim([property: JsonPropertyName("typ")] string? Typ, [property: JsonPropertyName("val")] string? Val);

    private sealed record Principal(
        [property: JsonPropertyName("name_typ")] string? NameTyp,
        [property: JsonPropertyName("role_typ")] string? RoleTyp,
        [property: JsonPropertyName("claims")] List<Claim>? Claims);

    /// <summary>
    /// Returns a ClaimsPrincipal with standard claim types (NameIdentifier = Entra object id,
    /// Name, Email, Role), or null when the header is missing or malformed.
    /// </summary>
    public static ClaimsPrincipal? Parse(string? header)
    {
        if (string.IsNullOrEmpty(header)) return null;

        Principal? principal;
        try
        {
            principal = JsonSerializer.Deserialize<Principal>(Encoding.UTF8.GetString(Convert.FromBase64String(header)));
        }
        catch (Exception e) when (e is FormatException or JsonException or ArgumentException)
        {
            return null;
        }

        var claims = (principal?.Claims ?? []).Where(c => c.Typ is not null && c.Val is not null).ToList();
        IEnumerable<string> Values(IEnumerable<string?> types) =>
            claims.Where(c => types.Contains(c.Typ)).Select(c => c.Val!);
        string? First(params string?[] types) => Values(types).FirstOrDefault();

        var id = First(ObjectIdTypes);
        if (id is null) return null;

        var email = First(EmailTypes);
        var name = First("name") ?? (principal!.NameTyp is { } nameTyp ? First(nameTyp) : null) ?? email ?? id;
        var roles = Values(RoleTypes.Append(principal!.RoleTyp)).Distinct();

        return Build(id, name, email, roles);
    }

    /// <summary>Local development mock, built from DEV_FAKE_USER and DEV_FAKE_ROLES (comma-separated).</summary>
    public static ClaimsPrincipal? DevUser(string? email, string? roles)
    {
        if (string.IsNullOrWhiteSpace(email)) return null;
        var roleList = (roles ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        return Build("00000000-0000-0000-0000-000000000001", email.Split('@')[0], email, roleList);
    }

    private static ClaimsPrincipal Build(string id, string name, string? email, IEnumerable<string> roles)
    {
        var claims = new List<System.Security.Claims.Claim>
        {
            new(ClaimTypes.NameIdentifier, id),
            new(ClaimTypes.Name, name),
        };
        if (email is not null) claims.Add(new(ClaimTypes.Email, email));
        claims.AddRange(roles.Select(r => new System.Security.Claims.Claim(ClaimTypes.Role, r)));
        return new ClaimsPrincipal(new ClaimsIdentity(claims, AuthenticationType, ClaimTypes.Name, ClaimTypes.Role));
    }
}
