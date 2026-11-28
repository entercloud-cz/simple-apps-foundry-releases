"""The contract test of the default access policy (app/access.py).

saf:access-contract-test

It walks every registered /api route and checks who gets in, by level:
- not signed in: 401 everywhere but "public" routes;
- a user without a role (or only with roles that give no level): 403 everywhere but "user" and "public" routes;
- Reader (read): refused on every write and admin route;
- Editor (write): refused on every admin route;
- Admin: let through everywhere.
A route's level is its own @access(...), else the default below (the policy's table, written again
here so that a change to the policy fails this test). Never skip or weaken this test: `platform
check` (PC066) looks for it, and the delivery pipeline runs it.
"""

import re

from fastapi.routing import APIRoute, iter_route_contexts

from app.access import ACCESS_REFUSED, access_policy, declared_access
from tests.helpers import TEST_ROLES, client, signed_in

PEOPLE = {
    "anonymous": {},
    # Guest has no level and Stranger is not in the roles file: neither gives access.
    "no role": signed_in("Guest", "Stranger"),
    "Reader": signed_in("Reader"),
    "Editor": signed_in("Editor"),
    "Admin": signed_in("Admin"),
}

# Who the policy lets through for each access, by the table in ADR-0078.
LET_THROUGH = {
    "public": {"anonymous", "no role", "Reader", "Editor", "Admin"},
    "user": {"no role", "Reader", "Editor", "Admin"},
    "read": {"Reader", "Editor", "Admin"},
    "write": {"Editor", "Admin"},
    "admin": {"Admin"},
}


def default_access(method: str, path: str) -> str:
    if re.match(r"^/api/(admin|settings)(/|$)", path, re.IGNORECASE):
        return "admin"
    return "read" if method in ("GET", "HEAD") else "write"


def sample_path(pattern: str) -> str:
    """A concrete path for a route pattern: every parameter becomes "1"."""
    return re.sub(r"\{[^}]+\}", "1", pattern)


def refused_by_policy(response) -> bool:
    """A refusal by the policy, not by a stricter rule of the route itself (require_role)."""
    if response.status_code == 401:
        return True
    return response.status_code == 403 and response.json().get("detail") == ACCESS_REFUSED


def api_routes():
    return [route for route in iter_route_contexts(client().app.routes) if (route.path or "").startswith("/api")]


def test_sees_the_routes():
    routes = api_routes()
    assert routes, "no /api routes found"
    assert any(route.path == "/api/me" and declared_access(route.endpoint) == "user" for route in routes)


def test_every_api_route_runs_the_policy():
    # Only FastAPI routes get the app's dependencies: a plain Starlette route or a mount under /api would skip it.
    for route in api_routes():
        assert isinstance(route.original_route, APIRoute), f"{route.path} is not a FastAPI route"
        assert any(d.dependency is access_policy for d in route.dependencies), f"{route.path} skips the policy"


def test_policy_holds_for_every_api_route_and_level():
    c = client()
    failures = []
    for route in api_routes():
        for method in sorted(route.methods or []):
            access = declared_access(route.endpoint) or default_access(method, route.path)
            path = sample_path(route.path)
            where = f"{method} {route.path} ({access})"
            for who, headers in PEOPLE.items():
                response = c.request(method, path, headers=headers)
                if who in LET_THROUGH[access]:
                    if refused_by_policy(response):
                        failures.append(f"{where}: {who} was refused with {response.status_code}")
                else:
                    expected = 401 if who == "anonymous" else 403
                    if response.status_code != expected:
                        failures.append(f"{where}: {who} got {response.status_code}, not {expected}")
    assert failures == []


def test_uses_the_test_roles():
    assert client().app.state.roles is TEST_ROLES
