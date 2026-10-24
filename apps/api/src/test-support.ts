/**
 * Test-only helpers for the API's integration tests (not part of the app): a real app on a
 * freshly migrated scratch database, dev sign-in, and a `call` that drives one contract
 * operation and fails the test when the response does not match the contract.
 */
import { randomUUID } from 'node:crypto';

import { createDatabase, SchemaMigrator, type Db } from '@listora/db';
import { createLogger } from '@listora/shared';
import { createScratchDatabase, type ScratchDatabase } from '@listora/testing';
import type { ApiError, ErrorResponse } from '@listora/api-contract';
import type { FastifyInstance } from 'fastify';

import { buildApp } from './app.ts';
import { DevAuthDriver } from './auth/dev-driver.ts';
import { operationSpec, responseContractErrors } from './contract/contract.ts';
import type { ContractReply, OperationId } from './contract/routes.ts';
import type { PhotoUploads, UploadClaim, UploadedFile } from './photos/uploads.ts';
import { resolveTenant, type Tenant } from './tenancy.ts';

export const TEST_AUTH_SECRET = 'test-secret-that-is-at-least-32-characters-long';

export interface CallOptions {
  token?: string;
  params?: Record<string, string>;
  query?: Record<string, string | number | readonly string[]>;
  body?: unknown;
  /** Defaults to a new UUID for operations that take one; `null` sends none. */
  idempotencyKey?: string | null;
  headers?: Record<string, string>;
}

/** The JSON body of an operation's success responses (undefined for 204). */
export type SuccessBody<K extends OperationId> =
  Extract<ContractReply<K>, { body: unknown }> extends { body: infer Body } ? Body : undefined;

export interface CallResult<K extends OperationId> {
  status: number;
  /** The body as the success type; check `status` first. Already checked against the contract. */
  body: SuccessBody<K>;
  /** The `error` of an `ErrorResponse`; throws when the response is not an error. */
  error: ApiError;
  headers: Record<string, unknown>;
}

/** The `fieldErrors` fields of an error response, in order. */
export function fieldsOf(result: { error: ApiError }): string[] {
  return (result.error.fieldErrors ?? []).map((fieldError) => fieldError.field);
}

/** A stand-in for T-07's upload sessions: files are registered by the test. */
export class FakePhotoUploads implements PhotoUploads {
  readonly #files = new Map<string, { accountId: string; claim: UploadClaim }>();

  /** Registers an upload of `tenant`'s account and returns its `uploadFileId`. */
  add(
    tenant: Tenant,
    file: Partial<UploadedFile> = {},
    status: UploadClaim['status'] = 'ready',
  ): string {
    const id = randomUUID();
    const uploaded: UploadedFile = {
      storageKey: file.storageKey ?? `photos/${id}.jpg`,
      sha256: file.sha256 ?? 'a'.repeat(64),
      ...(file.width === undefined ? {} : { width: file.width }),
      ...(file.height === undefined ? {} : { height: file.height }),
    };
    this.#files.set(id, {
      accountId: tenant.accountId,
      claim: status === 'ready' ? { status, file: uploaded } : { status },
    });
    return id;
  }

  claim(_trx: unknown, tenant: Tenant, uploadFileId: string): Promise<UploadClaim> {
    const entry = this.#files.get(uploadFileId);
    return Promise.resolve(
      entry?.accountId === tenant.accountId ? entry.claim : { status: 'not_found' },
    );
  }
}

export interface TestApi {
  app: FastifyInstance;
  db: Db;
  /** URL of the scratch database, for tests that need a second session. */
  databaseUrl: string;
  uploads: FakePhotoUploads;
  /** The dev driver's clock, in milliseconds; move it to expire codes and sessions. */
  clock: { now: number };
  /** Signs in through the dev endpoints and returns the bearer token. */
  signIn(email: string): Promise<string>;
  /** The tenant a signed-in email acts as (signs in first if needed). */
  tenantOf(email: string): Promise<Tenant>;
  call<K extends OperationId>(operationId: K, options?: CallOptions): Promise<CallResult<K>>;
  close(): Promise<void>;
}

export async function createTestApi(prefix = 'api'): Promise<TestApi> {
  const scratch: ScratchDatabase = await createScratchDatabase(prefix);
  const db = createDatabase({ connectionString: scratch.url, max: 10 });
  try {
    await new SchemaMigrator(db).migrateToLatest();
  } catch (error) {
    await db.destroy();
    await scratch.drop();
    throw error;
  }

  const logLines: Record<string, unknown>[] = [];
  const logger = createLogger({
    service: 'api-test',
    level: 'info',
    destination: {
      write: (line: string) => logLines.push(JSON.parse(line) as Record<string, unknown>),
    },
  });
  const clock = { now: Date.now() };
  const auth = new DevAuthDriver({ secret: TEST_AUTH_SECRET, logger, now: () => clock.now });
  const uploads = new FakePhotoUploads();
  const app = buildApp({ db, auth, uploads, pingDatabase: () => Promise.resolve() });
  const tokens = new Map<string, string>();

  const signIn = async (email: string): Promise<string> => {
    const requested = await app.inject({
      method: 'POST',
      url: '/dev/auth/codes',
      payload: { email },
    });
    if (requested.statusCode !== 202) throw new Error(`code request failed: ${requested.body}`);
    const line = logLines.findLast((entry) => entry['email'] === email.toLowerCase());
    const code = line?.['devSignInCode'];
    if (typeof code !== 'string') throw new Error(`no dev sign-in code logged for ${email}`);
    const session = await app.inject({
      method: 'POST',
      url: '/dev/auth/sessions',
      payload: { email, code },
    });
    if (session.statusCode !== 200) throw new Error(`sign-in failed: ${session.body}`);
    const token = session.json<{ accessToken: string }>().accessToken;
    tokens.set(email, token);
    return token;
  };

  const call = async <K extends OperationId>(
    operationId: K,
    options: CallOptions = {},
  ): Promise<CallResult<K>> => {
    const spec = operationSpec(operationId);
    const path = spec.path.replace(/\{([A-Za-z0-9_]+)\}/g, (_, name: string) => {
      const value = options.params?.[name];
      if (value === undefined) throw new Error(`${operationId} needs path parameter ${name}`);
      return encodeURIComponent(value);
    });
    const search = new URLSearchParams();
    for (const [name, value] of Object.entries(options.query ?? {})) {
      for (const entry of Array.isArray(value) ? value : [value])
        search.append(name, String(entry));
    }
    const headers: Record<string, string> = { ...options.headers };
    if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`;
    const key =
      options.idempotencyKey === undefined && spec.idempotent
        ? randomUUID()
        : options.idempotencyKey;
    if (typeof key === 'string') headers['idempotency-key'] = key;

    const response = await app.inject({
      method: spec.method,
      url: search.size > 0 ? `${path}?${search.toString()}` : path,
      headers,
      ...(options.body === undefined ? {} : { payload: options.body as Record<string, unknown> }),
    });
    const body: unknown = response.body === '' ? undefined : response.json();
    const problems = responseContractErrors(operationId, response.statusCode, body);
    if (problems.length > 0) {
      throw new Error(
        `${operationId} answered ${String(response.statusCode)} with a body that breaks the contract: ` +
          `${JSON.stringify(problems)}\n${response.body}`,
      );
    }
    const error = (body as Partial<ErrorResponse> | undefined)?.error;
    return {
      status: response.statusCode,
      body: body as SuccessBody<K>,
      get error(): ApiError {
        if (!error)
          throw new Error(`${operationId} answered ${String(response.statusCode)}, not an error`);
        return error;
      },
      headers: response.headers,
    };
  };

  const tenantOf = async (email: string): Promise<Tenant> => {
    const token = tokens.get(email) ?? (await signIn(email));
    const identity = await auth.verifyAccessToken(token);
    if (!identity) throw new Error(`token for ${email} no longer verifies`);
    return resolveTenant(db, identity);
  };

  return {
    app,
    db,
    databaseUrl: scratch.url,
    uploads,
    clock,
    signIn,
    tenantOf,
    call,
    close: async () => {
      await app.close();
      await db.destroy();
      await scratch.drop();
    },
  };
}
