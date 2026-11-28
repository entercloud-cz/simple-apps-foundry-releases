"""FastAPI dependencies for sign-in and roles.

The default access policy (access.py) already guards every /api route by its method and path.
These dependencies add finer rules on top of it, e.g. a role that only some users have.

Usage:
- signed-in user required: add a parameter `user: CurrentUser`
- role required: `@app.get("/admin", dependencies=[Depends(require_role("Admin"))])`
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Annotated

from fastapi import Depends, HTTPException, Request

from .principal import PRINCIPAL_HEADER, User, parse_client_principal


def optional_user(request: Request) -> User | None:
    """The signed-in user, or None. Falls back to the DEV_FAKE_USER mock locally."""
    user = parse_client_principal(request.headers.get(PRINCIPAL_HEADER))
    return user or request.app.state.config.dev_user


def current_user(user: Annotated[User | None, Depends(optional_user)]) -> User:
    if user is None:
        raise HTTPException(status_code=401, detail="Sign-in required")
    return user


CurrentUser = Annotated[User, Depends(current_user)]


def require_role(*roles: str) -> Callable[[User], User]:
    def check(user: CurrentUser) -> User:
        if not user.has_any_role(*roles):
            raise HTTPException(status_code=403, detail="You do not have permission to do this")
        return user

    return check
