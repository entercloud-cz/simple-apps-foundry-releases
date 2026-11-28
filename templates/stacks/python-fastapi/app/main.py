"""FastAPI app: health endpoints, sign-in, the access policy, an example API, a start page and security headers."""

from __future__ import annotations

import logging
import time
from pathlib import Path

from fastapi import Depends, FastAPI, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .access import access, access_policy
from .auth import CurrentUser, require_role
from .config import Config
from .principal import PRINCIPAL_HEADER, parse_client_principal
from .roles import AppRoles

log = logging.getLogger("app")

HEALTH_PATHS = {"/healthz", "/readyz"}

STATIC_DIR = Path(__file__).resolve().parent / "static"

SECURITY_HEADERS = {
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; object-src 'none'; "
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
}


class EchoIn(BaseModel):
    message: str = Field(min_length=1, max_length=500)


def create_app(config: Config, roles: AppRoles) -> FastAPI:
    """`roles`: the app's roles and their levels, load_roles() in __main__.py."""
    # The access policy (access.py) runs before every route: it guards every /api route by its
    # method and path. Keep it here, for the whole app.
    app = FastAPI(
        title="app",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        dependencies=[Depends(access_policy)],
    )
    app.state.config = config
    app.state.roles = roles

    @app.middleware("http")
    async def front_door_and_headers(request: Request, call_next) -> Response:
        # Behind Azure Front Door the platform sets FRONT_DOOR_ID: reject requests that did
        # not come through it. Health probes come from the platform directly and are exempt.
        if config.front_door_id and request.url.path not in HEALTH_PATHS:
            ids = [i.strip().lower() for i in request.headers.get("x-azure-fdid", "").split(",")]
            if config.front_door_id.lower() not in ids:
                log.warning("request rejected: missing or wrong X-Azure-FDID")
                return JSONResponse({"detail": "Forbidden"}, status_code=403)
        started = time.perf_counter()
        response = await call_next(request)
        response.headers.update(SECURITY_HEADERS)
        if request.url.path not in HEALTH_PATHS:
            log.info(
                "request completed",
                extra={
                    "method": request.method,
                    "path": request.url.path,
                    "statusCode": response.status_code,
                    "durationMs": round((time.perf_counter() - started) * 1000),
                },
            )
        return response

    # Liveness: never check databases or other services here.
    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    # Readiness: add checks for what this replica needs (e.g. database reachable).
    @app.get("/readyz")
    def readyz() -> dict[str, str]:
        return {"status": "ready"}

    # Who am I? The user menu shows the name, the email and the roles with what each may do. Any
    # signed-in user may ask, also one without a role (the page then says so): access "user".
    @app.get("/api/me")
    @access("user")
    def me(request: Request, user: CurrentUser) -> dict[str, object]:
        return {
            "id": user.id,
            "name": user.name,
            "email": user.email,
            "roles": [role.to_json() for role in roles.roles_of(user)],
            "level": roles.level_of(user),
            # True on your computer: the fake user from DEV_FAKE_USER, no platform sign-in.
            "isDevUser": parse_client_principal(request.headers.get(PRINCIPAL_HEADER)) is None,
        }

    # Under /api/admin: the policy lets only the admin level in. require_role adds a finer rule on
    # top (here: exactly the Admin role); role values are defined in the portal.
    @app.get("/api/admin/ping", dependencies=[Depends(require_role("Admin"))])
    def admin_ping() -> dict[str, str]:
        return {"message": "pong (only users with the Admin role can see this)"}

    # A POST: the policy needs the level write. Invalid input gets a 422.
    @app.post("/api/echo")
    def echo(body: EchoIn) -> dict[str, str]:
        return {"message": body.message}

    # The start page (static/): the user menu, and the place to build the app's pages.
    @app.get("/", include_in_schema=False)
    def index() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    return app
