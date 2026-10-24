/**
 * Runtime view of the API contract. Validators are compiled from `openapi.yaml` itself
 * (through `loadContractDocument`), so the server checks requests against exactly the schemas
 * the iOS client is generated from, and there is no hand-written copy that could drift.
 */
import type { FieldError } from '@listora/api-contract';
import {
  CONTRACT_METHODS,
  loadContractDocument,
  openEnumKnownRef,
  type ContractDocument,
  type ContractMethod,
  type ContractOperation,
  type ContractParameter,
  type ContractSchema,
} from '@listora/api-contract';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

/** Schema ids under which the contract's component schemas are registered with Ajv. */
const REQUEST_SCHEMAS_ID = 'urn:listora:contract:request';
const RESPONSE_SCHEMAS_ID = 'urn:listora:contract:response';
const COMPONENT_SCHEMA_REF = /^#\/components\/schemas\/([A-Za-z0-9_]+)$/;

// ajv-formats is CommonJS; under nodenext its default import is the module object.
const addFormats = addFormatsModule as unknown as typeof addFormatsModule.default;

export interface ParameterSpec {
  name: string;
  in: 'path' | 'query' | 'header';
  required: boolean;
}

/** One operation of the contract with its validators. */
export interface OperationSpec {
  operationId: string;
  method: Uppercase<ContractMethod>;
  /** The contract path, for example `/v1/items/{itemId}`. */
  path: string;
  /** The same path in Fastify's syntax, for example `/v1/items/:itemId`. */
  url: string;
  /** Whether the operation requires a bearer token (the contract's `security`). */
  secured: boolean;
  /** Whether the operation takes the `Idempotency-Key` header. */
  idempotent: boolean;
  bodyRequired: boolean;
  parameters: readonly ParameterSpec[];
  validatePath: Validator;
  validateQuery: Validator;
  /** Absent when the operation has no JSON body. */
  validateBody: Validator | undefined;
}

export type ValidationResult = { ok: true; value: unknown } | { ok: false; errors: FieldError[] };
export type Validator = (value: unknown) => ValidationResult;

/** A contract with its validators compiled. */
export interface CompiledContract {
  /** The validators of one operation; throws for an operationId the contract does not define. */
  operation(operationId: string): OperationSpec;
  operations(): readonly OperationSpec[];
  /**
   * Problems with a response body against the operation's schema for that status (or its
   * `default`), with every object closed to properties the contract does not declare; empty
   * when the body is valid.
   */
  responseErrors(operationId: string, status: number, body: unknown): FieldError[];
}

let contract: CompiledContract | undefined;

/** The compiled `openapi.yaml`, built on first use. */
function loadContract(): CompiledContract {
  contract ??= compileContract(loadContractDocument());
  return contract;
}

export function operationSpec(operationId: string): OperationSpec {
  return loadContract().operation(operationId);
}

export function contractOperations(): readonly OperationSpec[] {
  return loadContract().operations();
}

/** Used by tests to prove the server sends exactly what the contract promises. */
export function responseContractErrors(
  operationId: string,
  status: number,
  body: unknown,
): FieldError[] {
  return loadContract().responseErrors(operationId, status, body);
}

export function compileContract(document: ContractDocument): CompiledContract {
  const schemas = document.components.schemas;

  // Requests are held to the known values: an open enum `X` (`anyOf: [KnownX, string]`)
  // validates as `KnownX`, so an unknown value is rejected with 422 instead of being stored.
  const requestDefs: Record<string, ContractSchema> = {};
  for (const [name, schema] of Object.entries(schemas)) {
    const knownRef = openEnumKnownRef(schema as Parameters<typeof openEnumKnownRef>[0]);
    requestDefs[name] = knownRef
      ? { $ref: refInto(REQUEST_SCHEMAS_ID, knownRef) }
      : rewriteRefs(schema, REQUEST_SCHEMAS_ID);
  }
  const responseDefs: Record<string, ContractSchema> = {};
  for (const [name, schema] of Object.entries(schemas)) {
    responseDefs[name] = closeObjects(rewriteRefs(schema, RESPONSE_SCHEMAS_ID));
  }

  // Bodies and path parameters are validated as sent; query strings arrive as text, so their
  // validator coerces (`limit=25` to a number, a single `status=draft` to an array).
  const bodyAjv = createAjv(false, { $id: REQUEST_SCHEMAS_ID, $defs: requestDefs });
  const queryAjv = createAjv('array', { $id: REQUEST_SCHEMAS_ID, $defs: requestDefs });
  const responseAjv = createAjv(false, { $id: RESPONSE_SCHEMAS_ID, $defs: responseDefs });

  const operations = new Map<string, OperationSpec>();
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of CONTRACT_METHODS) {
      const operation = item[method];
      if (!operation) continue;
      const parameters = [...(item.parameters ?? []), ...(operation.parameters ?? [])].map(
        (parameter) => resolveRef(document, parameter),
      );
      const requestBody = operation.requestBody && resolveRef(document, operation.requestBody);
      const bodySchema = requestBody?.content?.['application/json']?.schema;
      const security = operation.security ?? document.security ?? [];
      operations.set(operation.operationId, {
        operationId: operation.operationId,
        method: method.toUpperCase() as Uppercase<ContractMethod>,
        path,
        url: path.replace(/\{([A-Za-z0-9_]+)\}/g, ':$1'),
        secured: security.length > 0,
        idempotent: parameters.some(
          (parameter) => parameter.in === 'header' && parameter.name === 'Idempotency-Key',
        ),
        bodyRequired: requestBody?.required === true,
        parameters: parameters.map((parameter) => ({
          name: requireName(parameter, operation.operationId),
          in: parameter.in as ParameterSpec['in'],
          required: parameter.required === true,
        })),
        validatePath: compile(bodyAjv, parametersSchema(parameters, 'path')),
        validateQuery: compile(queryAjv, parametersSchema(parameters, 'query')),
        validateBody: bodySchema
          ? compile(bodyAjv, rewriteRefs(bodySchema, REQUEST_SCHEMAS_ID))
          : undefined,
      });
    }
  }
  const responseValidators = new Map<string, ValidateFunction>();
  return {
    operation: (operationId) => {
      const spec = operations.get(operationId);
      if (!spec) throw new Error(`The API contract has no operation ${operationId}`);
      return spec;
    },
    operations: () => [...operations.values()],
    responseErrors: (operationId, status, body) => {
      const cacheKey = `${operationId} ${String(status)}`;
      let validate = responseValidators.get(cacheKey);
      if (!validate) {
        const operation = findOperation(document, operationId);
        const declared = operation.responses[String(status)] ?? operation.responses['default'];
        const schema = (declared && resolveRef(document, declared))?.content?.['application/json']
          ?.schema;
        if (!schema) {
          return body === undefined
            ? []
            : [{ field: '', message: `the contract declares no body for ${String(status)}` }];
        }
        validate = responseAjv.compile(rewriteRefs(schema, RESPONSE_SCHEMAS_ID));
        responseValidators.set(cacheKey, validate);
      }
      return validate(body) ? [] : toFieldErrors(validate.errors ?? []);
    },
  };
}

function createAjv(coerceTypes: false | 'array', defs: ContractSchema): Ajv2020 {
  // `useDefaults` fills in the contract's defaults (for example `quantity: 1`), which the
  // generated types already treat as present.
  const ajv = new Ajv2020({ allErrors: true, strict: true, coerceTypes, useDefaults: true });
  addFormats(ajv, ['date', 'date-time', 'uri']);
  // ajv-formats' `uuid` also accepts a `urn:uuid:` prefix, which Postgres rejects.
  ajv.addFormat('uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  ajv.addFormat('int32', {
    type: 'number',
    validate: (value: number) => Number.isInteger(value) && value >= -(2 ** 31) && value < 2 ** 31,
  });
  ajv.addFormat('int64', {
    type: 'number',
    validate: (value: number) => Number.isSafeInteger(value),
  });
  ajv.addSchema(defs);
  return ajv;
}

function compile(ajv: Ajv2020, schema: ContractSchema): Validator {
  const validate = ajv.compile(schema);
  return (value) => {
    // Coercion and defaults write into the value, so validate a copy.
    const copy: unknown = value === undefined ? undefined : structuredClone(value);
    return validate(copy)
      ? { ok: true, value: copy }
      : { ok: false, errors: toFieldErrors(validate.errors ?? []) };
  };
}

/** An object schema with one property per parameter of the given location. */
function parametersSchema(
  parameters: readonly ContractParameter[],
  location: 'path' | 'query',
): ContractSchema {
  const matching = parameters.filter((parameter) => parameter.in === location);
  return {
    type: 'object',
    properties: Object.fromEntries(
      matching.map((parameter) => [
        parameter.name,
        rewriteRefs(parameter.schema ?? {}, REQUEST_SCHEMAS_ID),
      ]),
    ),
    required: matching.filter((parameter) => parameter.required).map((parameter) => parameter.name),
  };
}

/** Ajv errors as the contract's `fieldErrors`: one entry per field, dotted paths. */
export function toFieldErrors(errors: readonly ErrorObject[]): FieldError[] {
  const byField = new Map<string, { keyword: string; message: string }>();
  for (const error of errors) {
    const segments = error.instancePath
      .split('/')
      .slice(1)
      .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
    let message: string;
    switch (error.keyword) {
      case 'required':
        segments.push((error.params as { missingProperty: string }).missingProperty);
        message = 'is required';
        break;
      case 'additionalProperties':
        segments.push((error.params as { additionalProperty: string }).additionalProperty);
        message = 'is not allowed';
        break;
      case 'enum':
        message = `must be one of ${(error.params as { allowedValues: unknown[] }).allowedValues.map(String).join(', ')}`;
        break;
      default:
        message = error.message ?? 'is invalid';
    }
    const field = segments.join('.');
    const existing = byField.get(field);
    // `anyOf` only says that no branch matched; keep a branch's specific error when there is one.
    if (!existing || (existing.keyword === 'anyOf' && error.keyword !== 'anyOf')) {
      byField.set(field, { keyword: error.keyword, message: message.slice(0, 500) });
    }
  }
  return [...byField].map(([field, { message }]) => ({ field, message }));
}

function findOperation(document: ContractDocument, operationId: string): ContractOperation {
  for (const item of Object.values(document.paths)) {
    for (const method of CONTRACT_METHODS) {
      if (item[method]?.operationId === operationId) return item[method];
    }
  }
  throw new Error(`The API contract has no operation ${operationId}`);
}

function requireName(parameter: ContractParameter, operationId: string): string {
  if (!parameter.name || !parameter.in || parameter.in === 'cookie') {
    throw new Error(`Unsupported parameter in ${operationId}`);
  }
  return parameter.name;
}

/** Follows a local `$ref` (`#/components/...`) to its target. */
function resolveRef<T extends { $ref?: string }>(document: ContractDocument, node: T): T {
  if (node.$ref === undefined) return node;
  let current: unknown = document;
  for (const key of node.$ref.replace(/^#\//, '').split('/')) {
    current = (current as Record<string, unknown> | undefined)?.[key];
  }
  if (current === undefined) throw new Error(`Unresolvable $ref ${node.$ref}`);
  return resolveRef(document, current as T);
}

function refInto(schemasId: string, ref: string): string {
  const match = COMPONENT_SCHEMA_REF.exec(ref);
  if (!match) throw new Error(`Unsupported $ref ${ref}`);
  return `${schemasId}#/$defs/${match[1] ?? ''}`;
}

/** A deep copy with every component schema `$ref` pointing at the registered Ajv schema. */
function rewriteRefs(schema: ContractSchema, schemasId: string): ContractSchema {
  return JSON.parse(JSON.stringify(schema), (key, value: unknown) =>
    key === '$ref' && typeof value === 'string' ? refInto(schemasId, value) : value,
  ) as ContractSchema;
}

/**
 * Marks every object schema that lists its properties as closed (`additionalProperties:
 * false`), so a response with a property the contract does not declare fails validation.
 */
function closeObjects(schema: ContractSchema): ContractSchema {
  const visit = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    const record = node as Record<string, unknown>;
    const properties = record['properties'] as Record<string, unknown> | undefined;
    if (properties !== undefined) {
      record['additionalProperties'] ??= false;
      for (const child of Object.values(properties)) visit(child);
    }
    visit(record['items']);
    visit(record['additionalProperties']);
    for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
      for (const child of (record[keyword] as unknown[] | undefined) ?? []) visit(child);
    }
  };
  visit(schema);
  return schema;
}
