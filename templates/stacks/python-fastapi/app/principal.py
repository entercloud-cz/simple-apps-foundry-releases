"""Reads the signed-in user from the X-MS-CLIENT-PRINCIPAL header.

The platform's sign-in (Azure Container Apps built-in authentication, "Easy Auth")
signs users in with Microsoft Entra ID before a request reaches the app, and adds
this header: base64-encoded JSON with the user's claims. Never implement your own
login. Locally there is no Easy Auth: use DEV_FAKE_USER / DEV_FAKE_ROLES instead.

This module has no framework dependencies so it can be copied into any Python app.
"""

from __future__ import annotations

import base64
import binascii
import json
from dataclasses import dataclass, field

PRINCIPAL_HEADER = "x-ms-client-principal"

_OBJECT_ID_TYPES = ("http://schemas.microsoft.com/identity/claims/objectidentifier", "oid")
_ROLE_TYPES = ("roles", "http://schemas.microsoft.com/ws/2008/06/identity/claims/role")
_EMAIL_TYPES = (
    "preferred_username",
    "email",
    "upn",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
)


@dataclass(frozen=True)
class User:
    id: str
    """Entra object id. Stable: use it as the key when you store data about a user."""
    name: str
    """Display name, for showing in the UI."""
    email: str | None = None
    """Sign-in name, usually the email address. Can change: never use it as a key."""
    roles: tuple[str, ...] = field(default_factory=tuple)
    """App role values assigned to the user (via Entra groups), e.g. ("Reader",)."""

    def has_any_role(self, *roles: str) -> bool:
        return any(role in self.roles for role in roles)


def parse_client_principal(header: str | None) -> User | None:
    """Returns the user, or None when the header is missing or malformed."""
    if not header:
        return None
    try:
        principal = json.loads(base64.b64decode(header, validate=False).decode("utf-8"))
    except (binascii.Error, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(principal, dict):
        return None

    claims = [
        c
        for c in principal.get("claims") or []
        if isinstance(c, dict) and isinstance(c.get("typ"), str) and isinstance(c.get("val"), str)
    ]

    def values(types: tuple[str, ...]) -> list[str]:
        return [c["val"] for c in claims if c["typ"] in types]

    def first(types: tuple[str, ...]) -> str | None:
        found = values(types)
        return found[0] if found else None

    user_id = first(_OBJECT_ID_TYPES)
    if not user_id:
        return None

    role_typ = principal.get("role_typ")
    role_types = (role_typ, *_ROLE_TYPES) if isinstance(role_typ, str) else _ROLE_TYPES
    name_typ = principal.get("name_typ")
    email = first(_EMAIL_TYPES)
    name = first(("name",)) or (first((name_typ,)) if isinstance(name_typ, str) else None) or email or user_id

    return User(id=user_id, name=name, email=email, roles=tuple(dict.fromkeys(values(role_types))))


def dev_user(email: str | None, roles: str | None) -> User | None:
    """Local development mock, built from DEV_FAKE_USER and DEV_FAKE_ROLES (comma-separated)."""
    if not email:
        return None
    return User(
        id="00000000-0000-0000-0000-000000000001",
        name=email.split("@")[0],
        email=email,
        roles=tuple(r.strip() for r in (roles or "").split(",") if r.strip()),
    )
