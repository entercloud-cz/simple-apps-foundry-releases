import base64
import json

from fastapi.testclient import TestClient

from app.config import load_config
from app.main import create_app
from app.roles import AppRoles, RoleDefinition

TEST_ROLES = AppRoles(
    sign_in=True,
    roles=(
        RoleDefinition("Reader", "Reader", "Can see the data.", "read"),
        RoleDefinition("Editor", "Editor", "Can change the data.", "write"),
        RoleDefinition("Admin", "Admin", "Can change the settings.", "admin"),
        RoleDefinition("Guest", "Guest", "Has no level yet.", None),
    ),
)
"""The roles the tests use, whatever .platform/roles.json says: one per level, and one without a
level (it gives no access). The tests check the policy by level, not the app's role names."""


def principal_header(roles: list[str] | None = None) -> str:
    """An X-MS-CLIENT-PRINCIPAL header value like the platform's sign-in sends."""
    principal = {
        "auth_typ": "aad",
        "role_typ": "http://schemas.microsoft.com/ws/2008/06/identity/claims/role",
        "claims": [
            {
                "typ": "http://schemas.microsoft.com/identity/claims/objectidentifier",
                "val": "11111111-1111-1111-1111-111111111111",
            },
            {"typ": "name", "val": "Test User"},
            {"typ": "preferred_username", "val": "test@contoso.com"},
            *({"typ": "roles", "val": r} for r in roles or []),
        ],
    }
    return base64.b64encode(json.dumps(principal).encode()).decode()


def signed_in(*roles: str) -> dict[str, str]:
    """Headers of a signed-in user with these app roles."""
    return {"x-ms-client-principal": principal_header(list(roles))}


def client(**env: str) -> TestClient:
    return TestClient(create_app(load_config(env), TEST_ROLES))
