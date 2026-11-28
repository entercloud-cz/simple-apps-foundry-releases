import base64
import json

import pytest
from fastapi.testclient import TestClient

from app.config import ConfigError, load_config
from app.main import create_app
from app.principal import parse_client_principal


def principal_header(roles: list[str] | None = None) -> str:
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


def client(**env: str) -> TestClient:
    return TestClient(create_app(load_config(env)))


def test_health_endpoints():
    c = client()
    assert c.get("/healthz").status_code == 200
    assert c.get("/readyz").status_code == 200


def test_sign_in_and_roles():
    c = client()
    assert c.get("/api/me").status_code == 401
    me = c.get("/api/me", headers={"x-ms-client-principal": principal_header(["Reader", "Reader"])})
    assert me.json() == {"name": "Test User", "email": "test@contoso.com", "roles": ["Reader"]}
    assert c.get("/api/admin/ping", headers={"x-ms-client-principal": principal_header(["Reader"])}).status_code == 403
    assert c.get("/api/admin/ping", headers={"x-ms-client-principal": principal_header(["Admin"])}).status_code == 200


def test_dev_mock_user_and_azure_guard():
    assert client(DEV_FAKE_USER="dev@contoso.com", DEV_FAKE_ROLES="Admin").get("/api/admin/ping").status_code == 200
    with pytest.raises(ConfigError):
        load_config({"CONTAINER_APP_NAME": "app", "DEV_FAKE_USER": "dev@contoso.com"})


def test_input_validation_and_security_headers():
    c = client(DEV_FAKE_USER="dev@contoso.com")
    assert c.post("/api/echo", json={"message": ""}).status_code == 422
    res = c.post("/api/echo", json={"message": "hi"})
    assert res.json() == {"message": "hi"}
    assert "default-src 'self'" in res.headers["content-security-policy"]


def test_front_door_check():
    fdid = "22222222-2222-2222-2222-222222222222"
    c = client(FRONT_DOOR_ID=fdid, DEV_FAKE_USER="dev@contoso.com")
    assert c.get("/api/me").status_code == 403
    assert c.get("/api/me", headers={"x-azure-fdid": fdid}).status_code == 200
    assert c.get("/healthz").status_code == 200


def test_malformed_principal():
    assert parse_client_principal("not-json") is None
    assert parse_client_principal(None) is None
