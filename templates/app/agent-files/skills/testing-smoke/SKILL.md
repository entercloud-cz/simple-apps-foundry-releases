---
name: testing-smoke
description: Use when writing or fixing tests, deciding what to test for a change, testing routes with sign-in and roles, running the container locally to check it starts and answers /healthz and /readyz, or understanding what platform check and the pipeline smoke test do. Also use when tests fail in the pipeline but pass locally.
---

# Tests and smoke tests

Every change comes with tests that would fail without it. Tests run locally and in the pipeline;
`platform check` additionally starts the container and calls `/healthz`.

## What to test

| Change | Minimum tests |
|---|---|
| New API route | 200 for the allowed role, **401** without user, **403** with the wrong role, **400** for invalid input |
| Business rule / calculation | unit tests with normal, edge and invalid values |
| Bug fix | a test that reproduces the bug (fails before the fix) |
| Database query | test against a real local database if possible; at least the mapping logic |
| Config | missing/invalid variable stops startup with a clear message |
| UI | keep logic out of components (pure functions → unit tests); manual check in nonprod |

Don't call real external services or Azure from tests. Inject fakes (pass dependencies into
`buildApp`/constructors).

## Node/TS (vitest + Fastify `inject`)

```ts
import { buildApp } from '../src/server/app.js';
import { principalHeader, testConfig } from './helpers.js';

it('only editors can create items', async () => {
  const app = await buildApp({ config: testConfig() });
  const asReader = await app.inject({
    method: 'POST', url: '/api/items', payload: { title: 'x' },
    headers: { 'x-ms-client-principal': principalHeader({ roles: ['Reader'] }) },
  });
  expect(asReader.statusCode).toBe(403);
  await app.close();
});
```

`test/helpers.ts` builds realistic `X-MS-CLIENT-PRINCIPAL` headers. Run `npm test`
(`npx vitest` for watch mode).

## Python (pytest + TestClient)

```python
def test_only_editors_can_create(client):
    res = client.post("/api/items", json={"title": "x"}, headers={"x-ms-client-principal": principal_header(["Reader"])})
    assert res.status_code == 403
```

Run `pytest`. .NET: xUnit + `WebApplicationFactory<Program>` (`tests/App.Tests`), run `dotnet test`.

## Local container smoke test

Proves the image builds, runs as non-root, listens on `PORT` and answers health checks, which is
what the pipeline does after deploy. Needs Docker.

```bash
sh .agents/skills/testing-smoke/scripts/smoke-local.sh          # builds ./Dockerfile, port 8080
sh .agents/skills/testing-smoke/scripts/smoke-local.sh 8080 /api/me
```

The script builds the image, starts it with `DEV_FAKE_USER`, waits for `/healthz`, checks
`/readyz` and optional extra paths, checks the user is not root, sends `SIGTERM` and verifies the
container stops within 30 s. See [scripts/smoke-local.sh](scripts/smoke-local.sh).

## `platform check`

Run before every commit. It validates `platform.yaml`, Dockerfile rules, scans for secrets and
forbidden files, runs a `/healthz` smoke test of the built image, warns about stale docs and checks
the agent files. Its output names each failed rule and how to fix it; fix the cause, never the
check.

## When tests pass locally but fail in the pipeline

- Lockfile out of date (`npm ci` fails) → run `npm install`, commit `package-lock.json`.
- Tests depend on local files, `.env`, time zone, locale or a running database → make them
  self-contained.
- Order-dependent tests or shared state → reset state per test.
- Line endings or case-sensitive paths (Windows/macOS vs Linux) → match file names exactly.

## Common mistakes

- Testing only the happy path; no 401/403 tests for protected routes.
- Tests that call the real database or external APIs in CI.
- Snapshot tests of whole pages that break on every UI change.
- Deleting or skipping a failing test to get a green build.
