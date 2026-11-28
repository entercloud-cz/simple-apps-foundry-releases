"""The app's default access policy, on every /api route, deny by default.

saf:access-policy

    GET, HEAD                                  needs the level read
    POST, PUT, PATCH, DELETE (any other)       needs write
    /api/admin/**, /api/settings/** (any)      needs admin
    signed in, but no role with a level        refused (403)
    not signed in                              401

`access_policy` is a dependency of the whole app (main.py: `FastAPI(dependencies=[...])`), so it
runs before every route. A route says otherwise only on its own declaration, so a reviewer sees
every exception:

    @app.get("/api/me")
    @access("user")          # any signed-in user, even without a role
    def me(...): ...

    @app.post("/api/search")
    @access("read")          # a read sent as POST
    def search(...): ...

    "read" | "write" | "admin"   that level
    "user"                       any signed-in user, whatever their roles
    "public"                     no sign-in at all: only an anonymous app or a deliberately public endpoint

Never weaken or remove this policy; declare an exception on its route only with the user's OK and
record it in docs/architecture.md. tests/test_access_contract.py checks every route against it.
Dependencies such as require_role("Admin") still work on top of it, for finer rules.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import Literal, TypeVar, get_args

from fastapi import HTTPException, Request

from .auth import optional_user
from .roles import AppRoles, level_allows

Access = Literal["read", "write", "admin", "user", "public"]
ACCESS_VALUES: tuple[Access, ...] = get_args(Access)

ACCESS_ATTRIBUTE = "saf_access"
"""The endpoint function's attribute that @access sets."""

ACCESS_REFUSED = "Your role in this app does not allow this"
"""The 403 detail when this policy refuses a request (tests tell it from other 403s)."""

_READ_METHODS = {"GET", "HEAD"}
_ADMIN_PREFIXES = ("/api/admin", "/api/settings")

F = TypeVar("F", bound=Callable[..., object])


def access(level: Access) -> Callable[[F], F]:
    """Declares who may call this route instead of the default policy. Put it under @app.get(...)."""
    if level not in ACCESS_VALUES:
        # A typo must not open or close a route silently: the app refuses to start.
        raise ValueError(f"access must be one of {', '.join(ACCESS_VALUES)}, not {level!r}")

    def mark(endpoint: F) -> F:
        setattr(endpoint, ACCESS_ATTRIBUTE, level)
        return endpoint

    return mark


def declared_access(endpoint: object) -> Access | None:
    return getattr(endpoint, ACCESS_ATTRIBUTE, None)


def _normalize(path: str) -> str:
    return re.sub(r"/{2,}", "/", path).lower()


def _under(path: str, prefix: str) -> bool:
    return path == prefix or path.startswith(prefix + "/")


def is_api_path(path: str) -> bool:
    return _under(_normalize(path), "/api")


def required_access(method: str, path: str, declared: Access | None) -> Access:
    """What a request needs: the route's declared access, else the default for its method and path."""
    if declared:
        return declared
    if any(_under(_normalize(path), prefix) for prefix in _ADMIN_PREFIXES):
        return "admin"
    return "read" if method.upper() in _READ_METHODS else "write"


def _app_path(request: Request) -> str:
    """The request's path inside the app (without a root path the app may be served under)."""
    path, root = request.scope.get("path", ""), request.scope.get("root_path", "")
    return path[len(root) :] if root and path.startswith(root) else path


async def access_policy(request: Request) -> None:
    path = _app_path(request)
    if not is_api_path(path):
        return
    needed = required_access(request.method, path, declared_access(request.scope.get("endpoint")))
    if needed == "public":
        return
    user = optional_user(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Sign-in required")
    if needed == "user":
        return
    roles: AppRoles = request.app.state.roles
    if not level_allows(roles.level_of(user), needed):
        raise HTTPException(status_code=403, detail=ACCESS_REFUSED)
