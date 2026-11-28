// The app's roles as the portal knows them, from .platform/roles.json. The platform writes that
// file into the repository (when it creates it, and with `platform agent-files update`); never edit
// it by hand: change the roles in the portal. The build copies it next to App.dll (App.csproj).
//
// Every role has a level: read (sees the app's data), write (also adds and changes it) or admin
// (also changes the app's settings). Levels nest: admin includes write, write includes read. A role
// without a level, or a role the sign-in carries that the file doesn't name, gives no access at all.

using System.Security.Claims;
using System.Text.Json;

namespace App.Auth;

/// <summary>What a role lets its users do. Levels nest: Admin includes Write, Write includes Read.</summary>
public enum RoleLevel
{
    Read = 1,
    Write = 2,
    Admin = 3,
}

/// <param name="Value">The role value in the sign-in token, e.g. "Reader" (case-sensitive).</param>
/// <param name="Description">What the role may do, in a sentence (the owner's words from the portal).</param>
/// <param name="Level">null: the role gives no access in the app.</param>
public sealed record RoleDefinition(string Value, string DisplayName, string Description, RoleLevel? Level);

public sealed class RolesFileException(string message) : Exception(message);

public sealed class AppRoles(bool signIn, IReadOnlyList<RoleDefinition> roles)
{
    /// <summary>false for an anonymous (public) app: nobody signs in.</summary>
    public bool SignIn { get; } = signIn;

    public IReadOnlyList<RoleDefinition> Roles { get; } = roles;

    /// <summary>The core's default roles: used when .platform/roles.json is missing (an older repository).</summary>
    public static AppRoles Defaults { get; } = new(true,
    [
        new("Reader", "Reader", "Can see the app and its data, but can't change anything.", RoleLevel.Read),
        new("Editor", "Editor", "Can do what a Reader can, and add and change the app's everyday data.", RoleLevel.Write),
        new("Admin", "Admin", "Can do everything in the app, including its settings and other users' data.", RoleLevel.Admin),
    ]);

    /// <summary>Where the build puts the file: next to App.dll.</summary>
    public static string DefaultPath => Path.Combine(AppContext.BaseDirectory, ".platform", "roles.json");

    /// <summary>The roles from the file, or the core's defaults when there is no file.</summary>
    public static AppRoles Load(string path) => File.Exists(path) ? Parse(File.ReadAllText(path)) : Defaults;

    /// <summary>Reads the roles file's JSON text. Throws RolesFileException when it isn't a roles file.</summary>
    public static AppRoles Parse(string json)
    {
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(json);
        }
        catch (JsonException)
        {
            throw new RolesFileException(".platform/roles.json is not valid JSON");
        }
        using (document)
        {
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object ||
                !root.TryGetProperty("roles", out var list) || list.ValueKind != JsonValueKind.Array)
            {
                throw new RolesFileException(".platform/roles.json is not valid: it needs a list `roles`");
            }
            var signIn = true;
            if (root.TryGetProperty("signIn", out var signInValue))
            {
                if (signInValue.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                    throw new RolesFileException(".platform/roles.json is not valid: `signIn` must be true or false");
                signIn = signInValue.GetBoolean();
            }
            var roles = new List<RoleDefinition>();
            foreach (var role in list.EnumerateArray())
            {
                var value = String(role, "value");
                if (string.IsNullOrEmpty(value))
                    throw new RolesFileException($".platform/roles.json is not valid: roles.{roles.Count} needs a `value`");
                var displayName = String(role, "displayName");
                roles.Add(new RoleDefinition(
                    value,
                    string.IsNullOrEmpty(displayName) ? value : displayName,
                    String(role, "description") ?? "",
                    // An unknown level is no level: the role gives no access (`platform check` warns, PC067).
                    ParseLevel(String(role, "level"))));
            }
            return new AppRoles(signIn, roles);
        }
    }

    /// <summary>The roles the file names that the user has, in the file's order.</summary>
    public IReadOnlyList<RoleDefinition> RolesOf(ClaimsPrincipal user) => Roles.Where(r => user.IsInRole(r.Value)).ToList();

    /// <summary>The user's highest level, or null when none of their roles gives access.</summary>
    public RoleLevel? LevelOf(ClaimsPrincipal user) => RolesOf(user).Max(r => r.Level);

    /// <summary>True when <paramref name="level"/> includes <paramref name="needed"/>.</summary>
    public static bool Allows(RoleLevel? level, RoleLevel needed) => level is { } l && l >= needed;

    /// <summary>The level as the API and the roles file write it: read, write, admin or null.</summary>
    public static string? LevelName(RoleLevel? level) => level switch
    {
        RoleLevel.Read => "read",
        RoleLevel.Write => "write",
        RoleLevel.Admin => "admin",
        _ => null,
    };

    private static RoleLevel? ParseLevel(string? name) => name switch
    {
        "read" => RoleLevel.Read,
        "write" => RoleLevel.Write,
        "admin" => RoleLevel.Admin,
        _ => null,
    };

    private static string? String(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) &&
        value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
}
