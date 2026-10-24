/**
 * Listora-specific rules for openapi.yaml that a generic linter cannot know. Redocly
 * (`npm run contract:lint`) checks that the document is valid OpenAPI; these tests check
 * that it follows the conventions in README.md, so new endpoints cannot quietly drop them.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Schema {
  $ref?: string;
  type?: string | string[];
  nullable?: boolean;
  enum?: string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  additionalProperties?: Schema | boolean;
  anyOf?: Schema[];
  oneOf?: Schema[];
  allOf?: Schema[];
}
interface Parameter {
  $ref?: string;
  name?: string;
  in?: string;
  required?: boolean;
}
interface Response {
  $ref?: string;
  content?: Record<string, { schema?: Schema }>;
}
interface Operation {
  operationId?: string;
  summary?: string;
  tags?: string[];
  security?: unknown[];
  parameters?: Parameter[];
  responses: Record<string, Response>;
}
interface Document {
  tags: { name: string }[];
  security: unknown[];
  paths: Record<string, Record<string, unknown>>;
  components: {
    schemas: Record<string, Schema>;
    parameters: Record<string, Parameter>;
    responses: Record<string, Response>;
  };
}

const doc = parse(readFileSync(join(import.meta.dirname, '../openapi.yaml'), 'utf8')) as Document;
const METHODS = ['get', 'put', 'post', 'patch', 'delete'] as const;

const operations = Object.entries(doc.paths).flatMap(([path, item]) => {
  const shared = (item['parameters'] ?? []) as Parameter[];
  return METHODS.flatMap((method) => {
    const op = item[method] as Operation | undefined;
    return op ? [{ path, method, op, parameters: [...shared, ...(op.parameters ?? [])] }] : [];
  });
});
const v1Operations = operations.filter(({ path }) => path.startsWith('/v1/'));
const label = ({ method, path }: { method: string; path: string }): string =>
  `${method.toUpperCase()} ${path}`;

function resolve<T extends { $ref?: string }>(node: T): T {
  if (!node.$ref) return node;
  const target = node.$ref.replace(/^#\//, '').split('/');
  let current: unknown = doc;
  for (const key of target) current = (current as Record<string, unknown>)[key];
  if (current === undefined) throw new Error(`Unresolvable $ref ${node.$ref}`);
  return resolve(current as T);
}

function responseSchema(op: Operation, status: string): Schema | undefined {
  const response = op.responses[status];
  if (!response) return undefined;
  const schema = resolve(response).content?.['application/json']?.schema;
  return schema ? resolve(schema) : undefined;
}

/** Every schema node in components, with a readable location. */
function* walkSchemas(): Generator<{ at: string; schema: Schema; property?: string }> {
  function* walk(
    schema: Schema,
    at: string,
    property?: string,
  ): Generator<{
    at: string;
    schema: Schema;
    property?: string;
  }> {
    yield property === undefined ? { at, schema } : { at, schema, property };
    for (const [name, child] of Object.entries(schema.properties ?? {})) {
      yield* walk(child, `${at}.${name}`, name);
    }
    if (schema.items) yield* walk(schema.items, `${at}[]`);
    if (typeof schema.additionalProperties === 'object') {
      yield* walk(schema.additionalProperties, `${at}{}`);
    }
    for (const child of [
      ...(schema.anyOf ?? []),
      ...(schema.oneOf ?? []),
      ...(schema.allOf ?? []),
    ]) {
      yield* walk(child, at);
    }
  }
  for (const [name, schema] of Object.entries(doc.components.schemas)) yield* walk(schema, name);
}

describe('operations', () => {
  it('have a unique camelCase operationId, a summary, and exactly one declared tag', () => {
    const declaredTags = new Set(doc.tags.map((tag) => tag.name));
    const ids = operations.map(({ op }) => op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of operations) {
      expect(entry.op.operationId, label(entry)).toMatch(/^[a-z][A-Za-z0-9]+$/);
      expect(entry.op.summary, label(entry)).toBeTruthy();
      expect(entry.op.tags, label(entry)).toHaveLength(1);
      expect(declaredTags.has(entry.op.tags?.[0] ?? ''), label(entry)).toBe(true);
    }
  });

  it('declare a default ErrorResponse on every /v1 operation', () => {
    for (const entry of v1Operations) {
      expect(entry.op.responses['default']?.$ref, label(entry)).toBe(
        '#/components/responses/DefaultError',
      );
    }
  });

  it('use ErrorResponse for every documented 4xx and 5xx /v1 response', () => {
    // Health probes answer 503 with their own HealthReady body.
    for (const entry of v1Operations) {
      for (const status of Object.keys(entry.op.responses).filter((s) => /^[45]/.test(s))) {
        expect(responseSchema(entry.op, status), `${label(entry)} ${status}`).toBe(
          doc.components.schemas['ErrorResponse'],
        );
      }
    }
  });

  it('require an Idempotency-Key header on every POST', () => {
    const posts = operations.filter(({ method }) => method === 'post');
    expect(posts.length).toBeGreaterThan(0);
    for (const entry of posts) {
      const header = entry.parameters
        .map((parameter) => resolve(parameter))
        .find((parameter) => parameter.in === 'header' && parameter.name === 'Idempotency-Key');
      expect(header?.required, label(entry)).toBe(true);
    }
  });

  it('never accept Idempotency-Key as optional anywhere', () => {
    expect(doc.components.parameters['IdempotencyKey']?.required).toBe(true);
  });

  it('require bearer auth on /v1 except the browser OAuth callback', () => {
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
    const unauthenticated = operations
      .filter(({ op }) => op.security?.length === 0)
      .map(({ op }) => op.operationId)
      .sort();
    expect(unauthenticated).toEqual(['getLiveness', 'getReadiness', 'handleConnectionCallback']);
  });

  it('use cursor pagination for every page response', () => {
    const paged = v1Operations.filter(
      ({ op }) => responseSchema(op, '200')?.properties?.['nextCursor'],
    );
    expect(paged.map(({ op }) => op.operationId).sort()).toEqual([
      'listItems',
      'listListings',
      'listOperationEvents',
      'listOperations',
      'listSales',
      'listTasks',
    ]);
    for (const entry of paged) {
      const refs = entry.parameters.map((parameter) => parameter.$ref);
      expect(refs, label(entry)).toContain('#/components/parameters/Cursor');
      expect(refs, label(entry)).toContain('#/components/parameters/Limit');
      const page = responseSchema(entry.op, '200');
      expect(page?.required, label(entry)).toEqual(['data']);
      expect(page?.properties?.['data']?.type, label(entry)).toBe('array');
      expect(page?.properties?.['nextCursor']?.type, label(entry)).toBe('string');
    }
  });
});

describe('schemas', () => {
  it('name every property in camelCase', () => {
    for (const { at, property } of walkSchemas()) {
      if (property !== undefined) expect(property, at).toMatch(/^[a-z][A-Za-z0-9]*$/);
    }
  });

  it('never use null: an absent property means no value', () => {
    for (const { at, schema } of walkSchemas()) {
      expect(schema.nullable, at).toBeUndefined();
      expect([schema.type].flat(), at).not.toContain('null');
    }
  });

  it('only list required properties that exist', () => {
    for (const { at, schema } of walkSchemas()) {
      for (const name of schema.required ?? []) {
        expect(Object.keys(schema.properties ?? {}), at).toContain(name);
      }
    }
  });

  it('represent every amount of money as Money (integer cents plus currency)', () => {
    // Judged by the last word of the camelCase name: listPrice, estimatedFees, shippingCharged.
    const money = /(price|cost|amount|fees|profit|shipping|charged|median|low|mid|high)$/i;
    for (const { at, schema, property } of walkSchemas()) {
      const lastWord = property?.split(/(?=[A-Z])/).at(-1) ?? '';
      if (!money.test(lastWord) || at.startsWith('Money.')) continue;
      // Capability flags such as `updatePrice` say how a price is changed, not what it is.
      if (at.startsWith('MarketplaceCapabilities.')) continue;
      expect(schema.$ref, at).toBe('#/components/schemas/Money');
    }
    const amountCents = doc.components.schemas['Money']?.properties?.['amountCents'];
    expect(amountCents?.type).toBe('integer');
  });

  it('allow floating-point numbers only for confidences and measurements', () => {
    const numbers = [...walkSchemas()].filter(({ schema }) => schema.type === 'number');
    expect(numbers.map(({ at }) => at).sort()).toEqual([
      'Confidence',
      'Measurement.value',
      'OcrLine.confidence',
    ]);
  });
});

describe('vocabulary', () => {
  const values = (name: string): string[] | undefined => doc.components.schemas[name]?.enum;

  // These sets mirror the data model (docs/architecture.md section 9). Changing one is a
  // contract change: update the database, the server, and the iOS app together.
  it.each([
    ['Marketplace', ['ebay', 'depop', 'poshmark', 'mercari']],
    [
      'ItemStatus',
      ['draft', 'ready', 'listed', 'sold_pending_delist', 'sold', 'shipped', 'archived'],
    ],
    [
      'ListingStatus',
      [
        'draft',
        'queued',
        'publishing',
        'active',
        'ending',
        'ended',
        'sold',
        'error',
        'unknown',
        'needs_user_action',
      ],
    ],
    ['OperationKind', ['create', 'revise', 'price', 'end', 'relist', 'mark_sold', 'verify']],
    [
      'OperationStatus',
      [
        'queued',
        'running',
        'retrying',
        'verifying',
        'succeeded',
        'failed',
        'needs_user_action',
        'canceled',
      ],
    ],
    [
      'UserTaskKind',
      ['list_manually', 'delist_manually', 'confirm_sale', 'reconnect', 'review_match'],
    ],
    ['SaleStatus', ['detected', 'confirmed', 'canceled', 'returned']],
    ['SaleDetectionSource', ['webhook', 'poll', 'email', 'manual']],
    ['Provenance', ['ai', 'ocr', 'barcode', 'user']],
    ['PhotoRole', ['front', 'back', 'tag', 'flaw', 'detail']],
  ])('%s matches the data model', (name, expected) => {
    expect(values(name)).toEqual(expected);
  });

  it('establishes success only by API read-back or user confirmation', () => {
    expect(values('VerificationMethod')).toEqual(['marketplace_api', 'user_confirmation']);
    for (const name of ['Listing', 'Operation']) {
      const properties = doc.components.schemas[name]?.properties ?? {};
      expect(properties['statusDisplay']?.$ref, name).toBe('#/components/schemas/StatusDisplay');
      expect(properties['verification']?.$ref, name).toBe('#/components/schemas/Verification');
    }
  });

  it('never labels an AI estimate or cost floor as sold data', () => {
    expect(values('SoldDataSource')).toEqual(['depop_inspiration', 'ebay_mi', 'own_history']);
    const soldComparables = doc.components.schemas['SoldComparables']?.properties ?? {};
    expect(soldComparables['source']?.$ref).toBe('#/components/schemas/SoldDataSource');
  });

  it('keeps error codes open so a new code never breaks an old client', () => {
    const errorCode = doc.components.schemas['ErrorCode'];
    expect(errorCode?.anyOf).toEqual([
      { $ref: '#/components/schemas/KnownErrorCode' },
      { type: 'string', maxLength: 64 },
    ]);
    const apiError = doc.components.schemas['ApiError'];
    expect(apiError?.required).toEqual(['code', 'message', 'retryable', 'requestId']);
  });
});
