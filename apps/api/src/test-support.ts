/**
 * Test-only helpers for the API's integration tests (not part of the app): a real app on a
 * freshly migrated scratch database, dev sign-in, and a `call` that drives one contract
 * operation and fails the test when the response does not match the contract.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDatabase, SchemaMigrator, type Db, type DbExecutor } from '@listora/db';
import {
  processPhoto,
  storageKeys,
  type PhotoJobPayload,
  type PhotoJobQueue,
  type PhotoProcessingDependencies,
  type PhotoProcessingOutcome,
} from '@listora/photos';
import { createLogger, sha256Hex } from '@listora/shared';
import { LocalDiskStorage } from '@listora/storage';
import { createScratchDatabase, type ScratchDatabase } from '@listora/testing';
import type { ApiError, ErrorResponse } from '@listora/api-contract';
import type { FastifyInstance } from 'fastify';

import { buildApp, type AppDependencies } from './app.ts';
import { DevAuthDriver } from './auth/dev-driver.ts';
import { operationSpec, responseContractErrors } from './contract/contract.ts';
import type { ContractReply, OperationId } from './contract/routes.ts';
import { resolveTenant, type Tenant } from './tenancy.ts';

export const TEST_AUTH_SECRET = 'test-secret-that-is-at-least-32-characters-long';
/** The origin `app.inject` requests use; local storage URLs start with it. */
export const TEST_BASE_URL = 'http://localhost:80';

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

/** A PhotoJobQueue that records jobs; `runAll` processes them the way the worker will. */
export class RecordingPhotoJobs implements PhotoJobQueue {
  readonly jobs: PhotoJobPayload[] = [];
  readonly #deps: () => PhotoProcessingDependencies;

  constructor(deps: () => PhotoProcessingDependencies) {
    this.#deps = deps;
  }

  enqueue(_executor: DbExecutor, job: PhotoJobPayload): Promise<void> {
    this.jobs.push(job);
    return Promise.resolve();
  }

  /** Runs every recorded job once, in order, and forgets them. */
  async runAll(): Promise<PhotoProcessingOutcome[]> {
    const outcomes: PhotoProcessingOutcome[] = [];
    for (const job of this.jobs.splice(0)) outcomes.push(await processPhoto(this.#deps(), job));
    return outcomes;
  }
}

export type TestUploadState = 'uploaded' | 'pending' | 'expired' | 'attached';

/**
 * Upload files made directly in the database and storage, for tests that only need a file to
 * attach. `uploads.int.test.ts` drives the real HTTP flow.
 */
export class TestUploads {
  readonly #db: Db;
  readonly #storage: LocalDiskStorage;
  readonly #clock: { now: number };

  constructor(db: Db, storage: LocalDiskStorage, clock: { now: number }) {
    this.#db = db;
    this.#storage = storage;
    this.#clock = clock;
  }

  /** Registers one file of `tenant`'s account and returns its `uploadFileId`. */
  async add(
    tenant: Tenant,
    options: { bytes?: Uint8Array } = {},
    state: TestUploadState = 'uploaded',
  ): Promise<string> {
    const bytes = options.bytes ?? new TextEncoder().encode(`file ${randomUUID()}`);
    const now = this.#clock.now;
    // An expired session was created a day ago and expired a moment ago.
    const createdAt = state === 'expired' ? new Date(now - 86_400_000) : new Date(now);
    const expiresAt = state === 'expired' ? new Date(now - 1_000) : new Date(now + 86_400_000);
    const session = await this.#db
      .insertInto('upload_session')
      .values({ account_id: tenant.accountId, created_at: createdAt, expires_at: expiresAt })
      .returning('id')
      .executeTakeFirstOrThrow();
    const id = randomUUID();
    const storageKey = storageKeys.upload(tenant.accountId, id);
    await this.#db
      .insertInto('upload_file')
      .values({
        id,
        account_id: tenant.accountId,
        session_id: session.id,
        position: 0,
        content_type: 'image/jpeg',
        byte_size: bytes.byteLength,
        sha256: sha256Hex(bytes),
        storage_key: storageKey,
        status: state === 'pending' || state === 'expired' ? 'pending' : state,
        uploaded_at: state === 'uploaded' || state === 'attached' ? new Date(now) : null,
        attached_at: state === 'attached' ? new Date(now) : null,
      })
      .execute();
    if (state !== 'pending') {
      await this.#storage.put(storageKey, bytes, { contentType: 'image/jpeg' });
    }
    return id;
  }
}

/** Storage and a job queue for unit tests that build the app but never upload anything. */
export function offlinePhotoDependencies(): Pick<AppDependencies, 'storage' | 'photoJobs'> {
  return {
    storage: new LocalDiskStorage({
      rootDir: join(tmpdir(), 'listora-unused-storage'),
      baseUrl: 'http://localhost',
      signingSecret: TEST_AUTH_SECRET,
    }),
    photoJobs: { enqueue: () => Promise.resolve() },
  };
}

export interface TestApi {
  app: FastifyInstance;
  db: Db;
  /** URL of the scratch database, for tests that need a second session. */
  databaseUrl: string;
  uploads: TestUploads;
  /** Local storage in a temporary directory, served by `app` like in development. */
  storage: LocalDiskStorage;
  storageDir: string;
  /** Jobs `addItemPhoto` added; `photoJobs.runAll()` processes them. */
  photoJobs: RecordingPhotoJobs;
  /** The clock for dev sign-in and upload sessions, in milliseconds; move it to expire them. */
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
  const storageDir = await mkdtemp(join(tmpdir(), `listora-${prefix}-storage-`));
  const storage = new LocalDiskStorage({
    rootDir: storageDir,
    baseUrl: TEST_BASE_URL,
    signingSecret: TEST_AUTH_SECRET,
    now: () => new Date(clock.now),
  });
  const photoJobs = new RecordingPhotoJobs(() => ({ db, storage, logger }));
  const uploads = new TestUploads(db, storage, clock);
  const app = buildApp({
    db,
    auth,
    storage,
    photoJobs,
    now: () => new Date(clock.now),
    pingDatabase: () => Promise.resolve(),
  });
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
    storage,
    storageDir,
    photoJobs,
    clock,
    signIn,
    tenantOf,
    call,
    close: async () => {
      await app.close();
      await db.destroy();
      await scratch.drop();
      await rm(storageDir, { recursive: true, force: true });
    },
  };
}
