"""FastAPI app: health endpoints, sign-in, an example API and security headers."""

from __future__ import annotations

import logging
import time

from fastapi import Depends, FastAPI, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .auth import CurrentUser, require_role
from .config import Config

log = logging.getLogger("app")

HEALTH_PATHS = {"/healthz", "/readyz"}

SECURITY_HEADERS = {
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; object-src 'none'; "
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
}


class EchoIn(BaseModel):
    message: str = Field(min_length=1, max_length=500)


def create_app(config: Config) -> FastAPI:
    app = FastAPI(title="app", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.config = config

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

    @app.get("/api/me")
    def me(user: CurrentUser) -> dict[str, object]:
        return {"name": user.name, "email": user.email, "roles": list(user.roles)}

    @app.get("/api/admin/ping", dependencies=[Depends(require_role("Admin"))])
    def admin_ping() -> dict[str, str]:
        return {"message": "pong (only users with the Admin role can see this)"}

    @app.post("/api/echo")
    def echo(body: EchoIn, _: CurrentUser) -> dict[str, str]:
        return {"message": body.message}

    return app
