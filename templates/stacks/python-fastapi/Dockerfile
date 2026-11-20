# syntax=docker/dockerfile:1
#
# Base image pinned to an exact version. For a fully reproducible build, also pin the
# digest: run `docker buildx imagetools inspect python:3.13.18-slim-trixie` and change both
# FROM lines to python:3.13.18-slim-trixie@sha256:<digest>. Never use `latest` or `python:3`.

# ---- build: install dependencies into a virtual environment ----
FROM python:3.13.18-slim-trixie AS build
ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
RUN python -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH
COPY requirements.txt .
RUN pip install -r requirements.txt

# ---- runtime ----
FROM python:3.13.18-slim-trixie AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH=/opt/venv/bin:$PATH \
    PORT=8080
# Unprivileged user; files stay owned by root and read-only for the app.
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin app
WORKDIR /app
COPY --from=build /opt/venv /opt/venv
COPY app ./app
USER app
EXPOSE 8080
# Exec form: python is PID 1 and receives SIGTERM directly.
CMD ["python", "-m", "app"]
