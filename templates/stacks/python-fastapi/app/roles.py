"""The app's roles as the portal knows them, from .platform/roles.json.

The platform writes that file into the repository (when it creates it, and with
`platform agent-files update`); never edit it by hand: change the roles in the portal. The
container image carries it (Dockerfile).

Every role has a level: read (sees the app's data), write (also adds and changes it) or admin
(also changes the app's settings). Levels nest: admin includes write, write includes read. A role
without a level, or a role the sign-in carries that the file doesn't name, gives no access at all.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from .principal import User

Level = Literal["read", "write", "admin"]
LEVELS: tuple[Level, ...] = ("read", "write", "admin")

ROLES_FILE = Path(__file__).resolve().parent.parent / ".platform" / "roles.json"


@dataclass(frozen=True)
class RoleDefinition:
    value: str
    """The role value in the sign-in token, e.g. "Reader" (case-sensitive)."""
    display_name: str
    description: str
    """What the role may do, in a sentence (the owner's words from the portal)."""
    level: Level | None
    """None: the role gives no access in the app."""

    def to_json(self) -> dict[str, str | None]:
        return {
            "value": self.value,
            "displayName": self.display_name,
            "description": self.description,
            "level": self.level,
        }


@dataclass(frozen=True)
class AppRoles:
    sign_in: bool
    """False for an anonymous (public) app: nobody signs in."""
    roles: tuple[RoleDefinition, ...]

    def roles_of(self, user: User) -> list[RoleDefinition]:
        """The roles the file names that the user has, in the file's order."""
        return [role for role in self.roles if role.value in user.roles]

    def level_of(self, user: User | None) -> Level | None:
        """The user's highest level, or None when none of their roles gives access."""
        if user is None:
            return None
        levels = [LEVELS.index(role.level) for role in self.roles_of(user) if role.level]
        return LEVELS[max(levels)] if levels else None


DEFAULT_ROLES = AppRoles(
    sign_in=True,
    roles=(
        RoleDefinition(
            value="Reader",
            display_name="Reader",
            description="Can see the app and its data, but can't change anything.",
            level="read",
        ),
        RoleDefinition(
            value="Editor",
            display_name="Editor",
            description="Can do what a Reader can, and add and change the app's everyday data.",
            level="write",
        ),
        RoleDefinition(
            value="Admin",
            display_name="Admin",
            description="Can do everything in the app, including its settings and other users' data.",
            level="admin",
        ),
    ),
)
"""The core's default roles: used when .platform/roles.json is missing (an older repository)."""


class RolesFileError(Exception):
    pass


def parse_roles(text: str) -> AppRoles:
    """Reads the roles file's JSON text. Raises RolesFileError when it isn't a roles file."""
    try:
        data = json.loads(text)
    except json.JSONDecodeError as err:
        raise RolesFileError(".platform/roles.json is not valid JSON") from err
    if not isinstance(data, dict) or not isinstance(data.get("roles"), list):
        raise RolesFileError(".platform/roles.json is not valid: it needs a list `roles`")
    sign_in = data.get("signIn", True)
    if not isinstance(sign_in, bool):
        raise RolesFileError(".platform/roles.json is not valid: `signIn` must be true or false")
    roles = []
    for i, role in enumerate(data["roles"]):
        value = role.get("value") if isinstance(role, dict) else None
        if not isinstance(value, str) or not value:
            raise RolesFileError(f".platform/roles.json is not valid: roles.{i} needs a `value`")
        display_name, description, level = role.get("displayName"), role.get("description"), role.get("level")
        roles.append(
            RoleDefinition(
                value=value,
                display_name=display_name if isinstance(display_name, str) and display_name else value,
                description=description if isinstance(description, str) else "",
                # An unknown level is no level: the role gives no access (`platform check` warns, PC067).
                level=level if level in LEVELS else None,
            )
        )
    return AppRoles(sign_in=sign_in, roles=tuple(roles))


def load_roles(path: Path = ROLES_FILE) -> AppRoles:
    """The roles from the file, or the core's defaults when there is no file."""
    return parse_roles(path.read_text(encoding="utf-8")) if path.is_file() else DEFAULT_ROLES


def level_allows(level: Level | None, needed: Level) -> bool:
    """True when `level` includes `needed` (admin includes write, write includes read)."""
    return level is not None and LEVELS.index(level) >= LEVELS.index(needed)
