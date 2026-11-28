import json

import pytest

from app.access import access, required_access
from app.config import ConfigError, load_config
from app.principal import parse_client_principal
from app.roles import DEFAULT_ROLES, RolesFileError, level_allows, load_roles, parse_roles
from tests.helpers import TEST_ROLES, client, signed_in


def test_health_endpoints():
    c = client()
    assert c.get("/healthz").status_code == 200
    assert c.get("/readyz").status_code == 200


def test_sign_in_and_roles():
    c = client()
    assert c.get("/api/me").status_code == 401
    me = c.get("/api/me", headers=signed_in("Reader", "Reader", "Guest", "Stranger"))
    assert me.json() == {
        "id": "11111111-1111-1111-1111-111111111111",
        "name": "Test User",
        "email": "test@contoso.com",
        "roles": [
            {"value": "Reader", "displayName": "Reader", "description": "Can see the data.", "level": "read"},
            {"value": "Guest", "displayName": "Guest", "description": "Has no level yet.", "level": None},
        ],
        "level": "read",
        "isDevUser": False,
    }
    assert c.get("/api/admin/ping", headers=signed_in("Reader")).status_code == 403
    assert c.get("/api/admin/ping", headers=signed_in("Admin")).status_code == 200


def test_me_for_a_user_without_a_role():
    me = client().get("/api/me", headers=signed_in())
    assert me.status_code == 200
    assert me.json()["roles"] == [] and me.json()["level"] is None


def test_dev_mock_user_and_azure_guard():
    c = client(DEV_FAKE_USER="dev@contoso.com", DEV_FAKE_ROLES="Admin")
    assert c.get("/api/admin/ping").status_code == 200
    assert c.get("/api/me").json()["isDevUser"] is True
    with pytest.raises(ConfigError):
        load_config({"CONTAINER_APP_NAME": "app", "DEV_FAKE_USER": "dev@contoso.com"})


def test_input_validation_and_security_headers():
    c = client(DEV_FAKE_USER="dev@contoso.com", DEV_FAKE_ROLES="Editor")
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


def test_start_page_shows_the_user_menu():
    c = client()
    page = c.get("/")
    assert page.status_code == 200
    assert "/.auth/logout?post_logout_redirect_uri=/" in page.text
    assert "/.auth/login/aad?prompt=select_account&amp;post_login_redirect_uri=/" in page.text
    assert c.get("/static/app.js").status_code == 200
    assert c.get("/static/styles.css").status_code == 200


def test_roles_file(tmp_path):
    roles = parse_roles(
        json.dumps(
            {
                "signIn": True,
                "roles": [
                    {"value": "Viewer", "displayName": "Viewer", "description": "Sees reports.", "level": "read"},
                    {"value": "Approver", "level": "owner"},
                    {"value": "Clerk"},
                ],
            }
        )
    )
    assert [(r.value, r.display_name, r.description, r.level) for r in roles.roles] == [
        ("Viewer", "Viewer", "Sees reports.", "read"),
        ("Approver", "Approver", "", None),
        ("Clerk", "Clerk", "", None),
    ]
    with pytest.raises(RolesFileError):
        parse_roles("not json")
    with pytest.raises(RolesFileError):
        parse_roles('{"roles": [{"level": "read"}]}')
    assert load_roles(tmp_path / "roles.json") is DEFAULT_ROLES
    (tmp_path / "roles.json").write_text('{"signIn": false, "roles": []}', encoding="utf-8")
    assert load_roles(tmp_path / "roles.json").sign_in is False


def test_levels():
    user = parse_client_principal(signed_in("Reader", "Editor")["x-ms-client-principal"])
    assert TEST_ROLES.level_of(user) == "write"
    nobody = parse_client_principal(signed_in("Guest", "Stranger")["x-ms-client-principal"])
    assert TEST_ROLES.level_of(nobody) is None
    assert level_allows("admin", "read") and level_allows("write", "read")
    assert not level_allows("read", "write") and not level_allows("write", "admin") and not level_allows(None, "read")


def test_required_access():
    assert required_access("GET", "/api/items", None) == "read"
    assert required_access("HEAD", "/api/items", None) == "read"
    assert required_access("DELETE", "/api/items/1", None) == "write"
    assert required_access("OPTIONS", "/api/items", None) == "write"
    assert required_access("GET", "/api/settings", None) == "admin"
    assert required_access("GET", "/api//Admin/x", None) == "admin"
    assert required_access("POST", "/api/search", "read") == "read"
    with pytest.raises(ValueError):
        access("pubilc")  # type: ignore[arg-type]
