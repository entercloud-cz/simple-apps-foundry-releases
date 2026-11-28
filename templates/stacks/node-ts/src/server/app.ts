import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { registerAccessPolicy } from './auth/access.js';
import { registerAuth } from './auth/plugin.js';
import type { AppRoles } from './auth/roles.js';
import type { Config, LogLevel } from './config.js';
import { registerFrontDoorCheck } from './frontDoor.js';
import { apiRoutes } from './routes/api.js';
import { registerHealthRoutes, type ReadinessCheck } from './routes/health.js';

export interface AppOptions {
  config: Config;
  /** The app's roles and their levels: loadRoles('.platform/roles.json') in index.ts. */
  appRoles: AppRoles;
  /** Extra readiness checks, e.g. "database reachable" or "migrations done". */
  readinessChecks?: ReadinessCheck[];
  /** Folder with the built React app. Served only if it exists. */
  clientDir?: string;
}

/** JSON logs to stdout, one object per line, never secrets or tokens. */
export function loggerOptions(level: LogLevel): FastifyServerOptions['logger'] {
  return {
    level,
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    formatters: { level: (label: string) => ({ level: label }) },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-ms-client-principal"]',
        'req.headers["x-ms-token-aad-access-token"]',
        'req.headers["x-ms-token-aad-id-token"]',
      ],
      censor: '[redacted]',
    },
  };
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { config, appRoles, readinessChecks = [] } = options;
  const clientDir = options.clientDir ?? resolve(process.cwd(), 'dist/client');

  const app = Fastify({
    logger: loggerOptions(config.logLevel),
    // One log line per request (onResponse hook below) instead of Fastify's two.
    logController: new LogController({ disableRequestLogging: true }),
    requestIdHeader: 'x-request-id',
    trustProxy: true, // the platform's ingress sits in front of the app
  });

  // Order matters: Front Door check, then the user, then the access policy, then everything else.
  registerFrontDoorCheck(app, config.frontDoorId);
  registerAuth(app, config.devUser);
  registerAccessPolicy(app, appRoles);

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: null,
      },
    },
  });

  app.addHook('onResponse', async (request, reply) => {
    if (request.routeOptions.logLevel === 'warn' && reply.statusCode < 400) return; // health probes
    request.log.info(
      {
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
        userId: request.user?.id,
      },
      'request completed',
    );
  });

  app.setErrorHandler(async (error: Error & { statusCode?: number }, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err: error }, 'request failed');
      return reply.code(status).send({ error: 'Something went wrong' });
    }
    return reply.code(status).send({ error: error.message });
  });

  registerHealthRoutes(app, readinessChecks);
  await app.register(apiRoutes, { prefix: '/api', appRoles });

  if (existsSync(resolve(clientDir, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: clientDir,
      setHeaders: (reply, filePath) => {
        // Vite puts content-hashed files in /assets: cache them for long. Everything else: revalidate.
        const immutable = /[\\/]assets[\\/]/.test(filePath);
        reply.header('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
  }

  // Unknown /api paths get JSON 404s; other GETs get the React app (client-side routing).
  app.setNotFoundHandler(async (request, reply) => {
    const isPage = request.method === 'GET' && !request.url.startsWith('/api/');
    if (isPage && existsSync(resolve(clientDir, 'index.html'))) {
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    }
    return reply.code(404).send({ error: 'Not found' });
  });

  return app;
}
