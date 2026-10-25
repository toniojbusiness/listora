/**
 * Depop's published Selling API contract, as the fake Depop enforces it: a byte-for-byte copy
 * of https://partnerapi.depop.com/api-docs/openapi.yaml (`openapi.yaml` here; README.md says how
 * to refresh it), compiled into validators for each operation's path parameters, request body,
 * and responses. The fake checks every request it is sent and every response it sends against
 * them, so the adapter and the fake can't drift from Depop's own shapes together.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { parse } from 'yaml';

// ajv-formats is CommonJS; under nodenext its default import is the module object.
const addFormats = addFormatsModule as unknown as typeof addFormatsModule.default;

/** Where the vendored spec came from, and the SHA-256 of the copy (checked by a test). */
export const DEPOP_OPENAPI_SOURCE = {
  url: 'https://partnerapi.depop.com/api-docs/openapi.yaml',
  downloadedOn: '2026-10-24',
  sha256: '56fef8e38e4419badf4c3a7ab5a7919964307c0e858984fbe149d3c4d7de3d2b',
} as const;

export const DEPOP_OPENAPI_PATH = fileURLToPath(new URL('openapi.yaml', import.meta.url));

type Schema = Record<string, unknown>;

interface OpenApiDocument {
  paths: Record<string, Record<string, OpenApiOperation | undefined>>;
  components: { schemas: Record<string, Schema>; responses: Record<string, OpenApiResponse> };
}

interface OpenApiOperation {
  operationId: string;
  parameters?: { name: string; in: string; required?: boolean; schema?: Schema }[];
  requestBody?: { content?: Record<string, { schema?: Schema }> };
  responses?: Record<string, OpenApiResponse | { $ref: string }>;
}

interface OpenApiResponse {
  content?: Record<string, { schema?: Schema }>;
}

const METHODS = ['get', 'put', 'post', 'patch', 'delete'] as const;
const SCHEMAS_ID = 'urn:depop:selling-api';

/** One operation of the spec with its validators. */
export interface DepopSpecOperation {
  operationId: string;
  method: Uppercase<(typeof METHODS)[number]>;
  /** The spec's path, for example `/api/v1/products/by-sku/{sku}/`. */
  path: string;
  /** Problems with the path parameters; empty when they are valid. */
  pathErrors(params: Record<string, string>): string[];
  /** Problems with a JSON or form body; empty when valid, or when the operation takes none. */
  bodyErrors(body: unknown): string[];
  /** Problems with a JSON response body for `status`; empty when valid or not described. */
  responseErrors(status: number, body: unknown): string[];
}

export interface DepopSpec {
  /** The operation a request is for, with its path parameters; `undefined` when none matches. */
  match(
    method: string,
    path: string,
  ): { operation: DepopSpecOperation; params: Record<string, string> } | undefined;
  operation(operationId: string): DepopSpecOperation;
}

let compiled: DepopSpec | undefined;

/** The compiled spec, built on first use. */
export function loadDepopSpec(): DepopSpec {
  compiled ??= compileDepopSpec(readFileSync(DEPOP_OPENAPI_PATH, 'utf8'));
  return compiled;
}

export function depopSpecSha256(): string {
  return createHash('sha256').update(readFileSync(DEPOP_OPENAPI_PATH)).digest('hex');
}

export function compileDepopSpec(text: string): DepopSpec {
  const document = parse(text) as OpenApiDocument;
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
  addFormats(ajv);
  // OpenAPI's numeric formats; ajv-formats checks ranges only for int32, so these just pass.
  ajv.addFormat('int64', { type: 'number', validate: Number.isInteger });
  ajv.addSchema({ $id: SCHEMAS_ID, $defs: rewriteRefs(document.components.schemas) });

  const compile = (schema: Schema | undefined): ValidateFunction | undefined =>
    schema === undefined ? undefined : ajv.compile(rewriteRefs(schema));

  const operations: { operation: DepopSpecOperation; pattern: RegExp; names: string[] }[] = [];
  const byId = new Map<string, DepopSpecOperation>();
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of METHODS) {
      const spec = item[method];
      if (spec === undefined) continue;
      const pathParams = (spec.parameters ?? []).filter((param) => param.in === 'path');
      const paramValidators = pathParams.map((param) => ({
        name: param.name,
        validate: compile({ type: 'string', ...stringSchema(param.schema) }),
      }));
      const content = spec.requestBody?.content ?? {};
      const bodySchema =
        content['application/json']?.schema ?? content['application/x-www-form-urlencoded']?.schema;
      const validateBody = compile(bodySchema);
      const responseValidators = new Map<string, ValidateFunction | undefined>();
      for (const [status, response] of Object.entries(spec.responses ?? {})) {
        const resolved = '$ref' in response ? resolveResponse(document, response.$ref) : response;
        responseValidators.set(status, compile(resolved?.content?.['application/json']?.schema));
      }
      const operation: DepopSpecOperation = {
        operationId: spec.operationId,
        method: method.toUpperCase() as DepopSpecOperation['method'],
        path,
        pathErrors: (params) =>
          paramValidators.flatMap(({ name, validate }) =>
            validate === undefined || validate(params[name] ?? '')
              ? []
              : messages(validate.errors, name),
          ),
        bodyErrors: (body) =>
          validateBody === undefined || validateBody(body) ? [] : messages(validateBody.errors),
        responseErrors: (status, body) => {
          const validate = responseValidators.get(String(status));
          return validate === undefined || validate(body) ? [] : messages(validate.errors);
        },
      };
      const names: string[] = [];
      const pattern = new RegExp(
        `^${path
          .split(/(\{[^}]+\})/)
          .map((part) => {
            const name = /^\{([^}]+)\}$/.exec(part)?.[1];
            if (name === undefined) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            names.push(name);
            return '([^/]+)';
          })
          .join('')}$`,
      );
      operations.push({ operation, pattern, names });
      byId.set(operation.operationId, operation);
    }
  }
  // Literal paths before templated ones, so `/api/v1/products/by-sku/x/` never reads as the
  // legacy `/api/v1/products/{sku}/`.
  operations.sort((a, b) => a.names.length - b.names.length);

  return {
    match(method, path) {
      for (const { operation, pattern, names } of operations) {
        if (operation.method !== method.toUpperCase()) continue;
        const found = pattern.exec(path);
        if (found === null) continue;
        const params: Record<string, string> = {};
        names.forEach((name, index) => {
          params[name] = decodeURIComponent(found[index + 1] ?? '');
        });
        return { operation, params };
      }
      return undefined;
    },
    operation(operationId) {
      const operation = byId.get(operationId);
      if (operation === undefined) throw new Error(`Depop's spec has no ${operationId}`);
      return operation;
    },
  };
}

function stringSchema(schema: Schema | undefined): Schema {
  // Path parameters arrive as text; a numeric one is checked as digits.
  if (schema?.['type'] === 'integer' || schema?.['type'] === 'number') return { pattern: '^\\d+$' };
  const { maxLength } = schema ?? {};
  return maxLength === undefined ? {} : { maxLength };
}

function resolveResponse(document: OpenApiDocument, ref: string): OpenApiResponse | undefined {
  const name = /^#\/components\/responses\/(.+)$/.exec(ref)?.[1];
  return name === undefined ? undefined : document.components.responses[name];
}

/** Points `#/components/schemas/X` references at the registered `$defs`. */
function rewriteRefs<T>(value: T): T {
  if (Array.isArray(value)) return value.map(rewriteRefs) as T;
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] =
      key === '$ref' && typeof child === 'string'
        ? child.replace('#/components/schemas/', `${SCHEMAS_ID}#/$defs/`)
        : rewriteRefs(child);
  }
  return out as T;
}

function messages(errors: ErrorObject[] | null | undefined, prefix = ''): string[] {
  return (errors ?? []).map((error) => {
    const at = `${prefix}${error.instancePath}`;
    return `${at === '' ? 'body' : at} ${error.message ?? 'is invalid'}`;
  });
}
