"""Entry point: `python -m app`. Reads PORT, sets up JSON logs and telemetry, runs uvicorn."""

from __future__ import annotations

import json
import os
import sys
from datetime import UTC, datetime

import uvicorn

from .config import ConfigError, load_config, load_local_env_file
from .log import configure_logging


def main() -> None:
    load_local_env_file()
    try:
        config = load_config()
    except ConfigError as err:
        print(json.dumps({"time": datetime.now(UTC).isoformat(), "level": "fatal", "msg": str(err)}))
        sys.exit(1)

    configure_logging(config.log_level)

    if config.app_insights_connection_string:
        # Application Insights through OpenTelemetry. Must run before FastAPI is imported.
        os.environ.setdefault("OTEL_SERVICE_NAME", os.environ.get("CONTAINER_APP_NAME", "app"))
        from azure.monitor.opentelemetry import configure_azure_monitor

        configure_azure_monitor(connection_string=config.app_insights_connection_string)

    from .main import create_app  # imported after telemetry so FastAPI gets instrumented

    uvicorn.run(
        create_app(config),
        host="0.0.0.0",
        port=config.port,
        log_config=None,  # keep our JSON logging
        access_log=False,  # main.py logs one line per request
        proxy_headers=True,
        forwarded_allow_ips="*",  # only the platform's ingress can reach the container
        timeout_graceful_shutdown=25,  # the platform waits about 30 s after SIGTERM
    )


if __name__ == "__main__":
    main()
