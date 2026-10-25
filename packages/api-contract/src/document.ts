import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

/**
 * Absolute path of `openapi.yaml`, the root of the contract every other file is generated
 * from. It references the per-resource files in `paths/` and `components/`.
 */
export const CONTRACT_SPEC_PATH = fileURLToPath(new URL('../openapi.yaml', import.meta.url));

/** Absolute path of the contract bundled into one document (`npm run contract:generate`). */
export const CONTRACT_BUNDLE_PATH = fileURLToPath(
  new URL('../bundled/openapi.yaml', import.meta.url),
);

/** A JSON Schema node as the contract writes it (OpenAPI 3.1, so JSON Schema 2020-12). */
export interface ContractSchema {
  $ref?: string;
  [keyword: string]: unknown;
}

export interface ContractParameter {
  $ref?: string;
  name?: string;
  in?: 'path' | 'query' | 'header' | 'cookie';
  required?: boolean;
  schema?: ContractSchema;
}

export interface ContractMediaType {
  schema?: ContractSchema;
}

export interface ContractRequestBody {
  $ref?: string;
  required?: boolean;
  content?: Record<string, ContractMediaType>;
}

export interface ContractResponse {
  $ref?: string;
  content?: Record<string, ContractMediaType>;
}

export interface ContractOperation {
  operationId: string;
  security?: Record<string, unknown>[];
  parameters?: ContractParameter[];
  requestBody?: ContractRequestBody;
  responses: Record<string, ContractResponse>;
}

export const CONTRACT_METHODS = ['get', 'put', 'post', 'patch', 'delete'] as const;
export type ContractMethod = (typeof CONTRACT_METHODS)[number];

export type ContractPathItem = { parameters?: ContractParameter[] } & Partial<
  Record<ContractMethod, ContractOperation>
>;

export interface ContractDocument {
  openapi: string;
  security?: Record<string, unknown>[];
  paths: Record<string, ContractPathItem>;
  components: {
    schemas: Record<string, ContractSchema>;
    parameters: Record<string, ContractParameter>;
    responses: Record<string, ContractResponse>;
    requestBodies?: Record<string, ContractRequestBody>;
  };
}

/**
 * Parses the bundled contract, in which every reference is a `#/components/...` reference.
 * The server builds its request validators from this document, so requests are checked
 * against the contract itself rather than a hand-written copy of it. `npm run contract:check`
 * fails when the bundle is stale. Every call returns a fresh object that the caller may modify.
 */
export function loadContractDocument(): ContractDocument {
  return parse(readFileSync(CONTRACT_BUNDLE_PATH, 'utf8')) as ContractDocument;
}
