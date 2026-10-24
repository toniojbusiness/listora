import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { requestJson, type JsonRequest } from './http.ts';

describe('requestJson', () => {
  let server: Server | undefined;

  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => {
      if (server === undefined) resolve();
      else
        server.close(() => {
          resolve();
        });
    });
    server = undefined;
  });

  async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
    server = createServer(handler);
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  }

  const request = (url: string, extra: Partial<JsonRequest> = {}): JsonRequest => ({
    method: 'POST',
    url,
    body: { title: 'Jacket' },
    signal: new AbortController().signal,
    timeoutMs: 1_000,
    ...extra,
  });

  it('returns the status, headers, and parsed body of a response', async () => {
    const url = await serve((req, res) => {
      res.writeHead(201, { 'content-type': 'application/json', 'x-request-id': 'r1' });
      res.end(JSON.stringify({ ok: true, method: req.method }));
    });
    const result = await requestJson(request(url));
    expect(result).toMatchObject({
      type: 'response',
      status: 201,
      body: { ok: true, method: 'POST' },
    });
    expect(result.type === 'response' && result.headers.get('x-request-id')).toBe('r1');
  });

  it('parses an empty or non-JSON body as null', async () => {
    const url = await serve((req, res) => {
      res.writeHead(req.url === '/empty' ? 204 : 502);
      res.end(req.url === '/empty' ? undefined : '<html>Bad gateway</html>');
    });
    expect(await requestJson(request(`${url}/empty`))).toMatchObject({ status: 204, body: null });
    expect(await requestJson(request(`${url}/html`))).toMatchObject({ status: 502, body: null });
  });

  it('reports a refused connection as not sent, so retrying is safe', async () => {
    // A port that was just freed has no listener (fetch itself blocks reserved ports like 1).
    const url = await serve(() => undefined);
    const closed = server;
    server = undefined;
    await new Promise<void>((resolve) => {
      closed?.close(() => {
        resolve();
      });
    });
    expect(await requestJson(request(`${url}/listings`))).toEqual({
      type: 'not_sent',
      code: 'ECONNREFUSED',
    });
  });

  it('reports a timeout after sending as maybe sent', async () => {
    const url = await serve(() => undefined);
    expect(await requestJson(request(url, { timeoutMs: 100 }))).toEqual({
      type: 'maybe_sent',
      code: 'timeout',
    });
  });

  it('reports a dropped connection as maybe sent', async () => {
    const url = await serve((req) => {
      req.socket.destroy();
    });
    expect(await requestJson(request(url))).toEqual({
      type: 'maybe_sent',
      code: 'connection_lost',
    });
  });

  it('reports cancellation as maybe sent', async () => {
    const url = await serve(() => undefined);
    const controller = new AbortController();
    const pending = requestJson(request(url, { signal: controller.signal, timeoutMs: 5_000 }));
    setTimeout(() => {
      controller.abort();
    }, 50);
    expect(await pending).toEqual({ type: 'maybe_sent', code: 'aborted' });
  });
});
