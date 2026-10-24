import type { ContractDocument } from '@listora/api-contract';
import { createDatabase } from '@listora/db';
import { fastify } from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';

import { compileContract, contractOperations, operationSpec } from './contract.ts';
import { contractRoute } from './routes.ts';

/** A tiny contract with a schema shared by a request and a response, holding an open enum. */
const SYNTHETIC: ContractDocument = {
  openapi: '3.1.0',
  security: [{ bearerAuth: [] }],
  paths: {
    '/v1/things/{thingId}': {
      parameters: [
        { name: 'thingId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      put: {
        operationId: 'replaceThing',
        parameters: [{ name: 'dryRun', in: 'query', schema: { type: 'boolean' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Thing' } } },
        },
        responses: {
          '200': {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Thing' } } },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Color: {
        anyOf: [{ $ref: '#/components/schemas/KnownColor' }, { type: 'string', maxLength: 64 }],
      },
      KnownColor: { type: 'string', enum: ['red', 'blue'] },
      Thing: {
        type: 'object',
        required: ['color'],
        properties: {
          color: { $ref: '#/components/schemas/Color' },
          count: { type: 'integer', default: 1 },
        },
      },
    },
    parameters: {},
    responses: {},
  },
};

describe('compileContract', () => {
  const contract = compileContract(SYNTHETIC);
  const spec = contract.operation('replaceThing');

  it('derives the route and its security from the contract', () => {
    expect(spec).toMatchObject({
      method: 'PUT',
      path: '/v1/things/{thingId}',
      url: '/v1/things/:thingId',
      secured: true,
      idempotent: false,
      bodyRequired: true,
    });
  });

  it('holds requests to the known values of an open enum, and fills in defaults', () => {
    expect(spec.validateBody?.({ color: 'red' })).toEqual({
      ok: true,
      value: { color: 'red', count: 1 },
    });
    expect(spec.validateBody?.({ color: 'green' })).toEqual({
      ok: false,
      errors: [{ field: 'color', message: 'must be one of red, blue' }],
    });
  });

  it('lets responses carry values added after a client was built, but no undeclared property', () => {
    expect(contract.responseErrors('replaceThing', 200, { color: 'green', count: 2 })).toEqual([]);
    expect(contract.responseErrors('replaceThing', 200, { color: 'red', extra: true })).toEqual([
      { field: 'extra', message: 'is not allowed' },
    ]);
    expect(contract.responseErrors('replaceThing', 200, { color: null })).not.toEqual([]);
  });

  it('validates path parameters strictly and coerces query strings', () => {
    expect(spec.validatePath({ thingId: '0190a2b8-0000-7000-8000-000000000000' }).ok).toBe(true);
    expect(spec.validatePath({ thingId: 'urn:uuid:0190a2b8-0000-7000-8000-000000000000' }).ok).toBe(
      false,
    );
    expect(spec.validateQuery({ dryRun: 'true' })).toEqual({ ok: true, value: { dryRun: true } });
    expect(spec.validateQuery({ dryRun: 'maybe' }).ok).toBe(false);
  });

  it('never modifies the value it validates', () => {
    const body = { color: 'blue' };
    spec.validateBody?.(body);
    expect(body).toEqual({ color: 'blue' });
  });
});

describe('the Listora contract', () => {
  it('compiles every operation, and only health and the OAuth callback are public', () => {
    const operations = contractOperations();
    expect(operations.length).toBeGreaterThan(40);
    expect(
      operations
        .filter((op) => !op.secured)
        .map((op) => op.operationId)
        .sort(),
    ).toEqual(['getLiveness', 'getReadiness', 'handleConnectionCallback']);
    expect(operations.filter((op) => op.method === 'POST').every((op) => op.idempotent)).toBe(true);
  });

  it('reports nested body problems with dotted field paths', () => {
    const result = operationSpec('createItem').validateBody?.({
      details: { measurements: [{ name: 'length', value: -1, unit: 'in' }], colors: 'blue' },
    });
    expect(result).toEqual({
      ok: false,
      errors: [
        { field: 'details.colors', message: 'must be array' },
        { field: 'details.measurements.0.value', message: 'must be >= 0' },
      ],
    });
  });
});

describe('contractRoute', () => {
  const db = createDatabase({ connectionString: 'postgres://listora@127.0.0.1:1/unused' });

  afterAll(async () => {
    await db.destroy();
  });

  it('refuses to serve an operation the contract leaves public', () => {
    const app = fastify();
    const auth = { provider: 'dev' as const, verifyAccessToken: () => Promise.resolve(undefined) };
    expect(() => {
      contractRoute(app, { db, auth }, 'getLiveness', () =>
        Promise.resolve({ status: 200, body: { status: 'ok' } }),
      );
    }).toThrow(/public in the contract/);
  });
});
