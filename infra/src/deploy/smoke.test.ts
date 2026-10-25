import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { runSmoke, SmokeFailure, type SmokeAuth } from './smoke.ts';

type Handler = (request: IncomingMessage, body: string) => { status: number; body?: unknown };

/** A fake API: answers each `METHOD /path` (ids replaced by `:id`) and records the requests. */
async function fakeApi(overrides: Record<string, Handler> = {}) {
  const requests: { route: string; headers: IncomingMessage['headers']; body: string }[] = [];
  const item = { id: '0b3f1c2e-0000-4000-8000-000000000001', sku: 'SM-000001', status: 'draft' };
  let deleted = false;
  const defaults: Record<string, Handler> = {
    'GET /health/live': () => ({ status: 200, body: { status: 'ok' } }),
    'GET /health/ready': () => ({
      status: 200,
      body: { status: 'ok', checks: { database: 'ok' } },
    }),
    'POST /dev/auth/codes': () => ({ status: 202, body: { expiresInSeconds: 600 } }),
    'POST /dev/auth/sessions': (_request, body) =>
      (JSON.parse(body) as { code: string }).code === '123456'
        ? { status: 200, body: { accessToken: 'dev-token', tokenType: 'Bearer' } }
        : { status: 401, body: { error: { code: 'unauthenticated' } } },
    'POST /v1/items': () => ({ status: 201, body: item }),
    'GET /v1/items/:id': () => (deleted ? { status: 404 } : { status: 200, body: item }),
    'DELETE /v1/items/:id': () => {
      deleted = true;
      return { status: 204 };
    },
    'DELETE /v1/account': () => ({ status: 200, body: { marketplaceAccess: [] } }),
  };
  const handlers = { ...defaults, ...overrides };
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      const path = (request.url ?? '').replace(/[0-9a-f-]{36}/, ':id');
      const route = `${request.method ?? ''} ${path}`;
      requests.push({ route, headers: request.headers, body });
      const answer = handlers[route]?.(request, body) ?? { status: 404 };
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(answer.body === undefined ? '' : JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    requests,
    routes: () => requests.map((r) => r.route),
  };
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

const dev: SmokeAuth = { driver: 'dev', readCode: () => Promise.resolve('123456') };
const run = (apiUrl: string, auth: SmokeAuth = dev, lines: string[] = []) =>
  runSmoke({ apiUrl, auth, log: (line) => lines.push(line) });

describe('runSmoke', () => {
  it('checks health, signs in, creates, reads, and deletes an item, then deletes the account', async () => {
    const api = await fakeApi();
    const lines: string[] = [];
    await run(api.url, dev, lines);
    expect(api.routes()).toEqual([
      'GET /health/live',
      'GET /health/ready',
      'POST /dev/auth/codes',
      'POST /dev/auth/sessions',
      'POST /v1/items',
      'GET /v1/items/:id',
      'DELETE /v1/items/:id',
      'GET /v1/items/:id',
      'DELETE /v1/account',
    ]);
    const create = api.requests.find((request) => request.route === 'POST /v1/items');
    expect(create?.headers.authorization).toBe('Bearer dev-token');
    expect(create?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    // Never an analysis or a marketplace call: the smoke test costs no AI usage.
    expect(api.routes().some((route) => /analyses|listings|connections/.test(route))).toBe(false);
    expect(lines.at(-1)).toBe('smoke: ok');
  });

  it('fails when the database is unreachable, before signing in', async () => {
    const api = await fakeApi({
      'GET /health/ready': () => ({
        status: 503,
        body: { status: 'unavailable', checks: { database: 'unavailable' } },
      }),
    });
    await expect(run(api.url)).rejects.toThrow(
      new SmokeFailure(
        'health/ready',
        'expected HTTP 200, got 503: {"status":"unavailable","checks":{"database":"unavailable"}}',
      ),
    );
    expect(api.routes()).toEqual(['GET /health/live', 'GET /health/ready']);
  });

  it('fails on a wrong sign-in code', async () => {
    const api = await fakeApi();
    const wrong: SmokeAuth = { driver: 'dev', readCode: () => Promise.resolve('000000') };
    await expect(run(api.url, wrong)).rejects.toThrow(
      /sign-in \(dev\): exchange the code: expected HTTP 200, got 401/,
    );
  });

  it('reports a failed step and still cleans up the item and the account', async () => {
    const api = await fakeApi({
      'GET /v1/items/:id': () => ({ status: 500, body: { error: { code: 'internal_error' } } }),
    });
    await expect(run(api.url)).rejects.toThrow(/^read the item: expected HTTP 200, got 500/);
    expect(api.routes().slice(-2)).toEqual(['DELETE /v1/items/:id', 'DELETE /v1/account']);
  });

  it('fails when the item is still there after deleting it', async () => {
    const api = await fakeApi({
      'GET /v1/items/:id': () => ({ status: 200, body: { sku: 'SM-000001' } }),
    });
    await expect(run(api.url)).rejects.toThrow(
      /^the deleted item is gone: expected HTTP 404, got 200/,
    );
  });

  it('fails when the smoke account cannot be deleted', async () => {
    const api = await fakeApi({ 'DELETE /v1/account': () => ({ status: 503, body: {} }) });
    await expect(run(api.url)).rejects.toThrow(
      /^delete the smoke account: expected HTTP 200, got 503/,
    );
  });

  it('signs in with a Cognito ID token and keeps the Cognito user', async () => {
    const api = await fakeApi();
    await run(api.url, { driver: 'cognito', idToken: 'cognito-id-token' });
    expect(api.routes()).not.toContain('POST /dev/auth/codes');
    expect(api.routes()).not.toContain('DELETE /v1/account');
    const create = api.requests.find((request) => request.route === 'POST /v1/items');
    expect(create?.headers.authorization).toBe('Bearer cognito-id-token');
  });

  it('fails when the API cannot be reached', async () => {
    await expect(run('http://127.0.0.1:9')).rejects.toThrow();
  });
});
