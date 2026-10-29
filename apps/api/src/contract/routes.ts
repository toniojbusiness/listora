/**
 * `contractRoute` registers a handler for one contract operation, looked up by operationId:
 * - the method and URL come from openapi.yaml, so a route cannot drift from the contract;
 * - the request is authenticated and resolved to a `Tenant` before the body is even read
 *   (only operations the contract secures can be registered, so none is public by mistake), and
 *   counted against its account's request limit (rate-limits.ts);
 * - path, query, and body are validated against the contract (bad path ids → 404, bad query or
 *   body → 422 `validation_failed` with `fieldErrors`);
 * - POSTs with an `Idempotency-Key` run through `runIdempotent`;
 * - input and reply types are the generated contract types for that operation.
 */
import type { operations } from '@listora/api-contract';
import type { Db, DbExecutor, JsonValue } from '@listora/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AuthDriver, Identity } from '../auth/driver.ts';
import { ApiError, validationFailed } from '../errors.ts';
import { runIdempotent } from '../idempotency.ts';
import { limitAccount, type ApiRateLimiters } from '../rate-limits.ts';
import { authenticate, type SignUpPolicy, type Tenant } from '../tenancy.ts';
import { operationSpec } from './contract.ts';

export type OperationId = keyof operations;
type Operation<K extends OperationId> = operations[K];
type Responses<K extends OperationId> = Operation<K>['responses'];

type JsonBody<T> = T extends { content: { 'application/json': infer Body } } ? Body : never;

export type PathParams<K extends OperationId> = Operation<K>['parameters'] extends {
  path: infer Path;
}
  ? Path
  : Record<string, never>;

export type QueryParams<K extends OperationId> = Operation<K>['parameters'] extends {
  query?: infer Query;
}
  ? [Query] extends [never]
    ? Record<string, never>
    : NonNullable<Query>
  : Record<string, never>;

export type RequestBody<K extends OperationId> =
  Operation<K> extends { requestBody: infer Body } ? JsonBody<Body> : undefined;

type SuccessStatus<K extends OperationId> = Extract<keyof Responses<K>, 200 | 201 | 202 | 204>;

/** What a handler returns: one of the operation's success statuses and that status's body. */
export type ContractReply<K extends OperationId> = {
  [Status in SuccessStatus<K>]: Responses<K>[Status] extends {
    content: { 'application/json': infer Body };
  }
    ? { status: Status; body: Body }
    : { status: Status };
}[SuccessStatus<K>];

export interface ContractInput<K extends OperationId> {
  tenant: Tenant;
  /** The verified identity behind `tenant` (account deletion needs it). */
  identity: Identity;
  /** Use for every query. For an idempotent POST it is the request's transaction. */
  db: DbExecutor;
  params: PathParams<K>;
  query: QueryParams<K>;
  body: RequestBody<K>;
  request: FastifyRequest;
}

export type ContractHandler<K extends OperationId> = (
  input: ContractInput<K>,
) => Promise<ContractReply<K>>;

export interface RouteDependencies {
  db: Db;
  auth: AuthDriver;
  /** Who gets an account on their first sign-in. */
  signUp: SignUpPolicy;
  /** The per-account request limit, among the others (rate-limits.ts); none without it. */
  rateLimiters?: ApiRateLimiters | undefined;
}

const IDEMPOTENCY_KEY = 'idempotency-key';
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

export function contractRoute<K extends OperationId>(
  app: FastifyInstance,
  deps: RouteDependencies,
  operationId: K,
  handler: ContractHandler<K>,
): void {
  const spec = operationSpec(operationId);
  if (!spec.secured) {
    throw new Error(
      `${operationId} is public in the contract; contractRoute serves only secured operations`,
    );
  }

  app.route({
    method: spec.method,
    url: spec.url,
    config: { rateLimit: 'account' },
    // Before the body is parsed, so an unauthenticated client cannot make the server read it.
    onRequest: async (request) => {
      const { identity, tenant } = await authenticate(request, deps.auth, deps.db, deps.signUp);
      limitAccount(request, deps.rateLimiters, tenant.accountId);
      request.identity = identity;
      request.tenant = tenant;
    },
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const { tenant, identity } = request;
      if (!tenant || !identity) {
        throw new Error(`${operationId} reached its handler without a tenant`);
      }

      const path = spec.validatePath(request.params);
      // A malformed id names nothing that could exist.
      if (!path.ok) throw new ApiError('not_found', 'The requested resource was not found.');
      const key = spec.idempotent ? idempotencyKey(request) : undefined;
      const query = spec.validateQuery(request.query);
      if (!query.ok) throw validationFailed(query.errors);
      let body: unknown;
      if (spec.validateBody) {
        if (request.body === undefined) {
          if (spec.bodyRequired) {
            throw new ApiError('invalid_request', 'This request needs a JSON body.');
          }
        } else {
          const validated = spec.validateBody(request.body);
          if (!validated.ok) throw validationFailed(validated.errors);
          body = validated.value;
        }
      }

      const run = async (
        db: DbExecutor,
      ): Promise<{ status: number; body: JsonValue | undefined }> => {
        const result = await handler({
          tenant,
          identity,
          db,
          params: path.value as PathParams<K>,
          query: (query.value ?? {}) as QueryParams<K>,
          body: body as RequestBody<K>,
          request,
        });
        return {
          status: result.status,
          body: 'body' in result ? (result.body as JsonValue) : undefined,
        };
      };
      const response =
        key === undefined
          ? await run(deps.db)
          : await runIdempotent(
              deps.db,
              tenant,
              { key, operationId, request: { params: path.value, body } },
              run,
            );
      reply.code(response.status);
      return response.body === undefined ? reply.send() : reply.send(response.body);
    },
  });
}

function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers[IDEMPOTENCY_KEY];
  if (typeof value !== 'string' || value === '') {
    throw new ApiError(
      'invalid_request',
      'This request needs an Idempotency-Key header (a new UUID per action, reused on retries).',
    );
  }
  if (value.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new ApiError(
      'invalid_request',
      'The Idempotency-Key header is longer than 255 characters.',
    );
  }
  return value;
}
