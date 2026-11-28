// Application Insights through OpenTelemetry (Azure Monitor distro).
//
// Loaded before the app with `node --import ./dist/server/telemetry.js`, because
// instrumentation must be registered before http, fastify or pg are imported.
// Does nothing when APPLICATIONINSIGHTS_CONNECTION_STRING is not set (local dev).

import type { IncomingMessage } from 'node:http';
import type { InstrumentationOptions } from '@azure/monitor-opentelemetry';

let shutdown: () => Promise<void> = async () => undefined;

const connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;

if (connectionString) {
  // The app's name in Application Insights ("cloud role name").
  process.env.OTEL_SERVICE_NAME ??= process.env.CONTAINER_APP_NAME ?? 'app';

  await import('@azure/monitor-opentelemetry/loader');
  const { useAzureMonitor, shutdownAzureMonitor } = await import('@azure/monitor-opentelemetry');

  useAzureMonitor({
    azureMonitorExporterOptions: { connectionString },
    instrumentationOptions: {
      http: {
        enabled: true,
        // Health probes run every few seconds; don't pay for them as telemetry.
        ignoreIncomingRequestHook: (req: IncomingMessage) =>
          req.url === '/healthz' || req.url === '/readyz',
      } as InstrumentationOptions['http'],
      postgreSql: { enabled: true },
    },
  });
  shutdown = shutdownAzureMonitor;
}

/** Flushes buffered telemetry. Called on shutdown. */
export function shutdownTelemetry(): Promise<void> {
  return shutdown();
}
