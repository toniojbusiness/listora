import {
  knownErrorCodeValues,
  loadContractDocument,
  type ErrorResponse,
} from '@listora/api-contract';
import { createDatabase } from '@listora/db';
import { fastify } from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';

import { offlineDependencies } from './test-support.ts';
import { buildApp } from './app.ts';
import { DevAuthDriver } from './auth/dev-driver.ts';
import { responseContractErrors } from './contract/contract.ts';
import { ApiError, ERROR_STATUS, registerErrorHandling } from './errors.ts';

describe('ERROR_STATUS', () => {
  it('matches the HTTP status the contract documents for every code', () => {
    const description = String(
      loadContractDocument().components.schemas['KnownErrorCode']?.['description'],
    ).replace(/\s+/g, ' ');
    const documented = new Map<string, number>();
    // "`a`, `b` 409; `c` 413; ..." lists codes before the status they share.
    for (const [, codes = '', status = ''] of description.matchAll(
      /((?:`[a-z_]+`(?:, )?)+) (\d{3})/g,
    )) {
      for (const [, code = ''] of codes.matchAll(/`([a-z_]+)`/g))
        documented.set(code, Number(status));
    }
    expect(Object.fromEntries(documented)).toEqual(ERROR_STATUS);
    // The two codes left out appear only inside a failed authorization, never as a response.
    expect(knownErrorCodeValues.filter((code) => !(code in ERROR_STATUS))).toEqual([
      'marketplace_authorization_denied',
      'marketplace_authorization_failed',
    ]);
  });
});

describe('error responses', () => {
  const db = createDatabase({ connectionString: 'postgres://listora@127.0.0.1:1/unused' });
  const auth = new DevAuthDriver({ secret: 'x'.repeat(32), logger: fastify().log });
  const app = buildApp({
    db,
    auth,
    ...offlineDependencies(),
    pingDatabase: () => Promise.resolve(),
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  it('answers an unknown endpoint with a contract ErrorResponse and the request id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/nothing-here',
      headers: { 'x-request-id': 'trace-1' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.headers['x-request-id']).toBe('trace-1');
    expect(response.json()).toEqual({
      error: {
        code: 'not_found',
        message: 'There is no such endpoint.',
        retryable: false,
        requestId: 'trace-1',
      },
    });
  });

  it('replaces a request id that does not look like one', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': 'has spaces and\nnewlines' },
    });
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('maps malformed JSON, the wrong content type, and an oversized body', async () => {
    const malformed = await app.inject({
      method: 'POST',
      url: '/dev/auth/codes',
      headers: { 'content-type': 'application/json' },
      payload: '{"email":',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ error: { code: 'invalid_request' } });

    const wrongType = await app.inject({
      method: 'POST',
      url: '/dev/auth/codes',
      headers: { 'content-type': 'text/plain' },
      payload: 'hello',
    });
    expect(wrongType.statusCode).toBe(400);
    expect(wrongType.json()).toMatchObject({ error: { code: 'invalid_request' } });

    const huge = await app.inject({
      method: 'POST',
      url: '/dev/auth/codes',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'x'.repeat(2 * 1024 * 1024) }),
    });
    expect(huge.statusCode).toBe(413);
    expect(huge.json()).toMatchObject({ error: { code: 'payload_too_large' } });
  });

  it('treats an empty body without a content type as no body, as API Gateway forwards a DELETE', async () => {
    // API Gateway's HTTP API forwards a bodyless DELETE with `transfer-encoding: chunked` and no
    // content type; such a request reaches its route with no body (here: the missing email).
    const empty = await app.inject({
      method: 'POST',
      url: '/dev/auth/codes',
      headers: { 'transfer-encoding': 'chunked' },
      payload: '',
    });
    expect(empty.statusCode).toBe(422);
    expect(empty.json()).toMatchObject({ error: { code: 'validation_failed' } });

    // An empty body is no body whatever content type comes with it, except JSON, which must
    // then be valid JSON.
    for (const headers of [
      { 'content-type': 'text/plain', 'transfer-encoding': 'chunked' },
      { 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' },
    ]) {
      const typedEmpty = await app.inject({
        method: 'POST',
        url: '/dev/auth/codes',
        headers,
        payload: '',
      });
      expect(typedEmpty.statusCode, JSON.stringify(headers)).toBe(422);
    }

    // A body without a content type, or of any type but JSON, is still refused.
    for (const headers of [{ 'transfer-encoding': 'chunked' }, { 'content-type': 'text/xml' }]) {
      const refused = await app.inject({
        method: 'POST',
        url: '/dev/auth/codes',
        headers,
        payload: '{"email":"a@example.com"}',
      });
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({ error: { code: 'invalid_request' } });
    }
  });

  it('hides the details of an unexpected failure behind a generic, retryable 500', async () => {
    const lines: Record<string, unknown>[] = [];
    const failing = fastify({
      logger: {
        level: 'error',
        stream: {
          write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>),
        },
      },
    });
    registerErrorHandling(failing);
    failing.get('/boom', () => {
      throw new Error('connection to db-prod-1 failed: password authentication failed');
    });
    const response = await failing.inject({ method: 'GET', url: '/boom' });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      error: {
        code: 'internal_error',
        retryable: true,
        message: 'Something went wrong on our side. Try again.',
      },
    });
    expect(response.body).not.toContain('password');
    expect(lines.some((line) => line['msg'] === 'request failed')).toBe(true);
    await failing.close();
  });

  it('sends Retry-After with a retryable error and matches the contract', async () => {
    const throwing = fastify();
    registerErrorHandling(throwing);
    throwing.get('/busy', () => {
      throw new ApiError('rate_limited', 'Slow down.', { retryAfterSeconds: 30 });
    });
    const response = await throwing.inject({ method: 'GET', url: '/busy' });
    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('30');
    expect(responseContractErrors('getItem', 429, response.json())).toEqual([]);
    expect(response.json<ErrorResponse>().error).toMatchObject({
      retryable: true,
      retryAfterSeconds: 30,
    });
    await throwing.close();
  });
});
