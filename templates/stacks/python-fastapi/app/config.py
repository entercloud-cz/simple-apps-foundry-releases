"""All configuration comes from environment variables (app contract).

Add new settings here with a safe default, and document them in
docs/architecture.md (Configuration table).
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from .principal import User, dev_user


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class Config:
    port: int
    log_level: str
    on_azure: bool
    """True when running in Azure Container Apps (CONTAINER_APP_NAME is set by the platform)."""
    azure_client_id: str | None
    app_insights_connection_string: str | None
    front_door_id: str | None
    dev_user: User | None


def _get(env: Mapping[str, str], name: str) -> str | None:
    value = env.get(name, "").strip()
    return value or None


def load_config(env: Mapping[str, str] = os.environ) -> Config:
    on_azure = _get(env, "CONTAINER_APP_NAME") is not None
    problems: list[str] = []

    try:
        port = int(_get(env, "PORT") or "8080")
    except ValueError:
        problems.append("PORT must be a number")
        port = 0

    log_level = (_get(env, "LOG_LEVEL") or "info").upper()
    if log_level not in ("CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG"):
        problems.append("LOG_LEVEL must be one of critical, error, warning, info, debug")

    fake_user, fake_roles = _get(env, "DEV_FAKE_USER"), _get(env, "DEV_FAKE_ROLES")
    if on_azure and (fake_user or fake_roles):
        problems.append("DEV_FAKE_USER/DEV_FAKE_ROLES must not be set on Azure")

    if problems:
        # Only names and reasons, never values: values may be secrets.
        raise ConfigError("Invalid configuration: " + "; ".join(problems))

    return Config(
        port=port,
        log_level=log_level,
        on_azure=on_azure,
        azure_client_id=_get(env, "AZURE_CLIENT_ID"),
        app_insights_connection_string=_get(env, "APPLICATIONINSIGHTS_CONNECTION_STRING"),
        front_door_id=_get(env, "FRONT_DOOR_ID"),
        dev_user=dev_user(fake_user, fake_roles),
    )


def load_local_env_file(path: str = ".env") -> None:
    """Local development only: read KEY=VALUE lines from .env (never committed).

    Does nothing on Azure, where settings come from the platform and platform.yaml.
    Variables that are already set win over the file.
    """
    file = Path(path)
    if os.environ.get("CONTAINER_APP_NAME") or not file.is_file():
        return
    for line in file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
