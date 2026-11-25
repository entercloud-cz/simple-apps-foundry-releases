---
name: observability
description: Use when adding or changing logging, error reporting, metrics or tracing, when wiring Application Insights or OpenTelemetry, when deciding what to log (and what never to log), or when investigating behaviour from logs. Also use when the user asks where to see logs, errors, request counts or alerts for the app.
---

# Logging, telemetry and alerts

Two streams, both set up by the starters:

| Stream | Source | Where people see it |
|---|---|---|
| **Console logs** (JSON lines on stdout) | your logger | portal log viewer (search, level filter, live tail, "copy prompt for AI") |
| **Telemetry** (requests, dependencies, exceptions, traces) | OpenTelemetry → Application Insights, via `APPLICATIONINSIGHTS_CONNECTION_STRING` | portal; Application Insights in the Azure portal for owners with access |

The platform also records restarts, crashes and probe failures (system logs) and sends default
alerts to the owner and deputy: restarts/crash loop, 5xx rate, latency, no healthy replica.

## Logging rules

- One JSON object per line on stdout with at least `time`, `level`, `msg`. Use the stack's logger;
  never `console.log`/`print` in server code.
- Levels: `error` = something failed and needs attention; `warn` = unexpected but handled;
  `info` = business events and one line per request; `debug` = details for troubleshooting
  (off in prod via `LOG_LEVEL=info`).
- Put context in fields, not in the message: `log.info({ orderId, items: 3 }, 'order created')`.
- Log errors with the error object so the stack trace is kept: `log.error({ err }, 'export failed')`.
- Identify users by object id (`userId`), never by name or email.
- **Never log**: secrets, tokens, passwords, `Authorization`/`Cookie`/`X-MS-CLIENT-PRINCIPAL`/
  `X-MS-TOKEN-*` headers, full request or response bodies, personal data (names, emails, phone
  numbers, free-text fields), connection strings. The log viewer does not redact.
- Don't log in tight loops; aggregate (`{ processed: 1200, failed: 3 }`).

## Node/TS (starter: Fastify + pino)

- `request.log` inside handlers (includes `reqId`), `app.log` elsewhere. Configured in
  `src/server/app.ts` (`loggerOptions`): ISO time, string levels, sensitive headers redacted, one
  `request completed` line per request with `statusCode`, `durationMs`, `userId`; health probes
  are not logged.
- Telemetry: `src/server/telemetry.ts`, loaded first with `node --import`. It starts the Azure
  Monitor OpenTelemetry distro only when the connection string is set; HTTP, PostgreSQL and Azure
  SDK calls are traced automatically; health probes are excluded.
- Custom spans for slow business operations:

```ts
import { trace } from '@opentelemetry/api';     // add @opentelemetry/api with an exact version
const tracer = trace.getTracer('app');
await tracer.startActiveSpan('import-csv', async (span) => {
  try { /* … */ } finally { span.end(); }
});
```

## Python (starter)

`app/log.py` formats `logging` records as JSON; pass fields with `extra={...}`:
`log.info("order created", extra={"orderId": order_id})`. Telemetry: `configure_azure_monitor()`
in `app/__main__.py` before FastAPI is imported (instruments FastAPI, requests, psycopg).

## .NET (starter)

`AddJsonConsole` writes JSON; use message templates, not string interpolation:
`logger.LogInformation("Order {OrderId} created", orderId)`. Telemetry:
`builder.Services.AddOpenTelemetry().UseAzureMonitor()` when the connection string is set.
`AddHttpLogging` writes one line per request.

## Costs

Telemetry volume costs money. Defaults are fine for business apps. If an app handles many requests
per second, ask the platform team before raising log levels in prod; use sampling
(`samplingRatio` in `useAzureMonitor`, `OTEL_TRACES_SAMPLER_ARG`) rather than turning telemetry off.

## Reading logs

- Ask the user to open the app in the portal → logs, choose the environment and time range, filter
  by level `error`, and use "copy prompt for AI" to paste lines to you.
- Correlate by `reqId` (Node) / trace id across log lines.
- A container that restarts shows its last lines before the crash plus a system log entry
  (exit code, probe failure). See `troubleshooting`.

## Checklist

- [ ] New features log a business event at `info` and failures at `error` with context fields.
- [ ] No secrets or personal data in any log line (grep your diff for `log` calls).
- [ ] Errors returned to users are generic; details are only in logs.
- [ ] No new telemetry vendor SDKs (Sentry, Datadog, …) without a decision record and platform OK.

## Common mistakes

- `console.log(JSON.stringify(req.headers))` → leaks the principal header and cookies.
- Logging the full error response of an external API (may contain tokens or personal data).
- Initialising telemetry after importing the web framework → requests are not traced.
- Writing logs to files (`app.log`) → invisible to the platform and lost on restart.
- Multi-line log messages (pretty-printed JSON, stack traces as raw text) → split into many entries.
