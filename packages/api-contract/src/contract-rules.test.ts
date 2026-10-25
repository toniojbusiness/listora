/**
 * Listora-specific rules for the contract (openapi.yaml and the files it references, read as
 * the bundled document) that a generic linter cannot know. Redocly (the
 * package's `npm run lint`, part of `npm run contract:check`) checks that the document is
 * valid OpenAPI; these tests check
 * that it follows the conventions in README.md, so new endpoints cannot quietly drop them.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { CONTRACT_BUNDLE_PATH, CONTRACT_SPEC_PATH } from './document.ts';
import { openEnumKnownRef } from './open-enum.ts';

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
  schema?: Schema;
}
interface Response {
  $ref?: string;
  content?: Record<string, { schema?: Schema }>;
}
interface RequestBody {
  content?: Record<string, { schema?: Schema }>;
}
interface Operation {
  operationId?: string;
  summary?: string;
  tags?: string[];
  security?: unknown[];
  parameters?: Parameter[];
  requestBody?: RequestBody;
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

const doc = parse(readFileSync(CONTRACT_BUNDLE_PATH, 'utf8')) as Document;
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
    const money = /(price|cost|amount|fees|profit|proceeds|shipping|charged|median|low|mid|high)$/i;
    for (const { at, schema, property } of walkSchemas()) {
      const lastWord = property?.split(/(?=[A-Z])/).at(-1) ?? '';
      if (!money.test(lastWord) || at.startsWith('Money.')) continue;
      // Capability flags such as `updatePrice` say how a price is changed, not what it is.
      if (at.startsWith('MarketplaceCapabilities.')) continue;
      // A list of fees holds FeeLines, each with a Money `amount`.
      if (schema.type === 'array') {
        expect(schema.items?.$ref, at).toBe('#/components/schemas/FeeLine');
        continue;
      }
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

/**
 * Every closed enum a response can contain, by component name or inline location. Each was
 * chosen to stay closed: adding a value to one breaks installed apps (see README.md).
 */
const CLOSED_RESPONSE_ENUMS = [
  // Listora's own lifecycles, independent of marketplaces.
  'AnalysisStatus',
  'ConnectionAuthorizationStatus',
  'DelistRunStatus',
  'PhotoStatus',
  'UploadFileStatus',
  'UserTaskStatus',
  // Fixed by the product or by definition.
  'AnalysisTier',
  'FeeSource',
  'PriceTierName',
  'UserTaskUrgency',
  // Values the client chooses and the server echoes.
  'ImageContentType',
  'ItemCondition',
  'MeasurementUnit',
  'PhotoRole',
  // US-only launch; a new currency ships with app support for it.
  'CurrencyCode',
  // Infrastructure probes, not read by the app.
  'HealthCheckStatus',
  // HTTP protocol value.
  'UploadTarget.method',
  // The never-false-success invariant: success is established only these two ways.
  'VerificationMethod',
].sort();

/** Walks a schema, following $refs once each; reports closed enums and open enums found. */
function collectEnums(roots: Schema[]): {
  closed: Set<string>;
  open: Set<string>;
  known: Set<string>;
} {
  const closed = new Set<string>();
  const open = new Set<string>();
  const known = new Set<string>();
  const visited = new Set<string>();
  const visit = (schema: Schema, at: string): void => {
    if (schema.$ref) {
      const name = schema.$ref.replace('#/components/schemas/', '');
      if (name.startsWith('Known')) known.add(name);
      if (visited.has(name)) return;
      visited.add(name);
      visit(resolve(schema), name);
      return;
    }
    if (openEnumKnownRef(schema)) {
      open.add(at);
      return;
    }
    if (schema.enum) closed.add(at);
    for (const [name, child] of Object.entries(schema.properties ?? {})) {
      visit(child, `${at}.${name}`);
    }
    if (schema.items) visit(schema.items, `${at}[]`);
    if (typeof schema.additionalProperties === 'object') {
      visit(schema.additionalProperties, `${at}{}`);
    }
    for (const child of [
      ...(schema.anyOf ?? []),
      ...(schema.oneOf ?? []),
      ...(schema.allOf ?? []),
    ]) {
      visit(child, at);
    }
  };
  for (const root of roots) visit(root, '(root)');
  return { closed, open, known };
}

const responseSchemas = operations.flatMap(({ op }) =>
  Object.values(op.responses).flatMap((response) =>
    Object.values(resolve(response).content ?? {}).flatMap(({ schema }) =>
      schema ? [schema] : [],
    ),
  ),
);

describe('enums', () => {
  it('keep every growable response enum open (a Known* value or any string)', () => {
    const { closed } = collectEnums(responseSchemas);
    expect([...closed].sort()).toEqual(CLOSED_RESPONSE_ENUMS);
  });

  it('pair every Known* enum with an open schema of the same name', () => {
    const schemas = doc.components.schemas;
    const knownNames = Object.keys(schemas).filter((name) => name.startsWith('Known'));
    expect(knownNames.length).toBeGreaterThan(0);
    for (const name of knownNames) {
      expect(schemas[name]?.type, name).toBe('string');
      expect(schemas[name]?.enum?.length, name).toBeGreaterThan(0);
      const wrapper = schemas[name.slice('Known'.length)];
      expect(wrapper?.anyOf, name).toEqual([
        { $ref: `#/components/schemas/${name}` },
        { type: 'string', maxLength: 64 },
      ]);
    }
  });

  it('accept only known values in query and path parameters', () => {
    const parameters = operations.flatMap(({ parameters: list }) =>
      list.map((parameter) => resolve(parameter)),
    );
    const { open } = collectEnums(parameters.flatMap(({ schema }) => (schema ? [schema] : [])));
    expect([...open]).toEqual([]);
  });

  it('keep server-owned provenance out of every request', () => {
    const requestSchemas = operations.flatMap(({ op, parameters }) => [
      ...Object.values(op.requestBody?.content ?? {}).flatMap(({ schema }) =>
        schema ? [schema] : [],
      ),
      ...parameters.flatMap((parameter) => {
        const { schema } = resolve(parameter);
        return schema ? [schema] : [];
      }),
    ]);
    const visited = new Set<string>();
    const properties: string[] = [];
    const visit = (schema: Schema): void => {
      if (schema.$ref) {
        if (visited.has(schema.$ref)) return;
        visited.add(schema.$ref);
        visit(resolve(schema));
        return;
      }
      for (const [name, child] of Object.entries(schema.properties ?? {})) {
        properties.push(name);
        visit(child);
      }
      if (schema.items) visit(schema.items);
      if (typeof schema.additionalProperties === 'object') visit(schema.additionalProperties);
      for (const child of [
        ...(schema.anyOf ?? []),
        ...(schema.oneOf ?? []),
        ...(schema.allOf ?? []),
      ]) {
        visit(child);
      }
    };
    for (const schema of requestSchemas) visit(schema);
    expect(properties).toContain('details');
    expect(properties).not.toContain('fieldProvenance');
    expect(doc.components.schemas['Item']?.properties?.['fieldProvenance']).toBeDefined();
  });

  it('accept only known values in request-only enums', () => {
    // Shared schemas (ItemDetails, ...) keep open values so clients can send them back.
    for (const name of ['ListingCreate', 'SaleCreate']) {
      const marketplace = doc.components.schemas[name]?.properties?.['marketplace'];
      expect(marketplace?.$ref, name).toBe('#/components/schemas/KnownMarketplace');
    }
  });
});

describe('vocabulary', () => {
  const values = (name: string): string[] | undefined => doc.components.schemas[name]?.enum;

  // These sets mirror the data model (docs/architecture.md section 6). Changing one is a
  // contract change: update the database, the server, and the iOS app together.
  it.each([
    ['KnownMarketplace', ['ebay', 'depop', 'poshmark', 'mercari']],
    [
      'KnownItemStatus',
      ['draft', 'ready', 'listed', 'sold_pending_delist', 'sold', 'shipped', 'archived'],
    ],
    [
      'KnownListingStatus',
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
    ['KnownOperationKind', ['create', 'revise', 'price', 'end', 'relist', 'mark_sold', 'verify']],
    [
      'KnownOperationStatus',
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
      'KnownUserTaskKind',
      [
        'list_manually',
        'delist_manually',
        'edit_manually',
        'confirm_sale',
        'reconnect',
        'review_match',
        'resolve_double_sale',
      ],
    ],
    ['KnownSaleStatus', ['detected', 'confirmed', 'shipped', 'canceled', 'returned']],
    ['KnownRelistDecision', ['pending', 'relisted', 'declined']],
    ['KnownSaleDetectionSource', ['webhook', 'poll', 'email', 'manual']],
    ['KnownProvenance', ['ai', 'ocr', 'barcode', 'user']],
    ['PhotoRole', ['front', 'back', 'tag', 'flaw', 'detail']],
    ['KnownFeeType', ['marketplace', 'payment', 'shipping_label', 'promotion', 'tax', 'other']],
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
    expect(values('KnownSoldDataSource')).toEqual(['depop_inspiration', 'ebay_mi', 'own_history']);
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

describe('file layout', () => {
  // The root only points at the per-resource files, so a change to one resource edits that
  // resource's files (plus one line in openapi.yaml per new path or component) and never
  // another resource's.
  const root = parse(readFileSync(CONTRACT_SPEC_PATH, 'utf8')) as Document;

  it('defines every path in paths/<tag>.yaml, named after its operations tag', () => {
    for (const [path, item] of Object.entries(root.paths)) {
      const tags = [
        ...new Set(
          METHODS.flatMap(
            (method) => (doc.paths[path]?.[method] as Operation | undefined)?.tags ?? [],
          ),
        ),
      ];
      expect(tags, path).toHaveLength(1);
      const pointer = `#/${path.replaceAll('~', '~0').replaceAll('/', '~1')}`;
      expect(item, path).toEqual({ $ref: `./paths/${tags[0] ?? ''}.yaml${pointer}` });
    }
  });

  it.each(['parameters', 'responses'] as const)(
    'defines every component in components/%s.yaml',
    (kind) => {
      for (const [name, node] of Object.entries(root.components[kind])) {
        expect(node, name).toEqual({ $ref: `./components/${kind}.yaml#/${name}` });
      }
    },
  );

  it('defines every schema in a components/schemas/<area>.yaml file', () => {
    for (const [name, node] of Object.entries(root.components.schemas)) {
      expect(node.$ref, name).toMatch(
        new RegExp(`^\\./components/schemas/[a-z-]+\\.yaml#/${name}$`),
      );
      expect(Object.keys(node), name).toEqual(['$ref']);
    }
  });
});
