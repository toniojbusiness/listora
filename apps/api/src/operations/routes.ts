import {
  cancelOperation,
  ConcurrentOperationChangeError,
  IdempotencyConflictError,
  InvalidOperationError,
  InvalidTransitionError,
  OperationNotFoundError,
  retryOperation,
  SupersededOperationError,
} from '@listora/operations';
import type { OperationStatus } from '@listora/db';
import type { FastifyInstance } from 'fastify';

import { contractRoute, type RouteDependencies } from '../contract/routes.ts';
import { ApiError, notFound } from '../errors.ts';
import { decodeCursor, DEFAULT_PAGE_SIZE, encodeCursor } from '../pagination.ts';
import type { Tenant } from '../tenancy.ts';
import { findOperation, listEventRows, listOperationRows } from './repository.ts';
import { eventView, operationView } from './views.ts';

/**
 * Marketplace operations and their history (docs/features/operations.md): `listOperations`,
 * `getOperation`, `listOperationEvents`, and the Retry and Cancel actions, which go through the
 * operation engine's own commands so its rules (fresh attempts that read back first; never
 * cancel what may have been sent) hold for every client.
 */
export function registerOperationRoutes(app: FastifyInstance, deps: RouteDependencies): void {
  contractRoute(app, deps, 'listOperations', async ({ tenant, db, query }) => {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const rows = await listOperationRows(db, tenant, {
      itemId: query.itemId,
      listingId: query.listingId,
      statuses: query.status,
      beforeId: query.cursor === undefined ? undefined : decodeCursor(query.cursor),
      limit,
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      status: 200,
      body: {
        data: page.map((row) => operationView(row, row)),
        ...(rows.length > limit && last ? { nextCursor: encodeCursor(last.id) } : {}),
      },
    };
  });

  contractRoute(app, deps, 'getOperation', async ({ tenant, db, params }) => {
    const row = await findOperation(db, tenant, params.operationId);
    if (!row) throw notFound('Operation');
    return { status: 200, body: operationView(row, row) };
  });

  contractRoute(app, deps, 'listOperationEvents', async ({ tenant, db, params, query }) => {
    const operation = await findOperation(db, tenant, params.operationId);
    if (!operation) throw notFound('Operation');
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const rows = await listEventRows(db, tenant, operation.id, {
      afterId: query.cursor === undefined ? undefined : decodeCursor(query.cursor),
      limit,
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      status: 200,
      body: {
        data: page.map((row) => eventView(row, operation)),
        ...(rows.length > limit && last ? { nextCursor: encodeCursor(last.id) } : {}),
      },
    };
  });

  contractRoute(app, deps, 'retryOperation', async ({ tenant, db, params }) => {
    const operation = await engineCommand(() =>
      retryOperation(db, target(tenant, params.operationId)),
    );
    const row = await findOperation(db, tenant, operation.id);
    if (!row) throw notFound('Operation');
    return { status: 202, body: operationView(row, row) };
  });

  contractRoute(app, deps, 'cancelOperation', async ({ tenant, db, params }) => {
    const operation = await engineCommand(() =>
      cancelOperation(db, target(tenant, params.operationId)),
    );
    const row = await findOperation(db, tenant, operation.id);
    if (!row) throw notFound('Operation');
    return { status: 200, body: operationView(row, row) };
  });
}

function target(tenant: Tenant, operationId: string) {
  return { accountId: tenant.accountId, operationId };
}

/**
 * Runs an operation engine command, turning the engine's refusals into the contract's errors.
 * The engine filters by account, so another account's operation is not found.
 */
export async function engineCommand<T>(command: () => Promise<T>): Promise<T> {
  try {
    return await command();
  } catch (error) {
    throw engineError(error) ?? error;
  }
}

export function engineError(error: unknown): ApiError | undefined {
  if (error instanceof OperationNotFoundError) return notFound('Operation');
  if (error instanceof SupersededOperationError) {
    return new ApiError(
      'invalid_state_transition',
      'A newer change to this listing was made since, so this one can no longer be retried.',
      { cause: error },
    );
  }
  if (error instanceof InvalidTransitionError) {
    const state = STATE_WORDS[error.from];
    return new ApiError(
      'invalid_state_transition',
      error.to === 'canceled'
        ? `This change is ${state}, so it can no longer be canceled.`
        : `Only a failed change can be retried; this one is ${state}.`,
      { cause: error },
    );
  }
  if (error instanceof ConcurrentOperationChangeError) {
    return new ApiError(
      'invalid_state_transition',
      'This change was just updated. Reload and try again.',
      { cause: error },
    );
  }
  if (error instanceof IdempotencyConflictError) {
    return new ApiError('idempotency_key_reused', error.message, { cause: error });
  }
  if (error instanceof InvalidOperationError) {
    return new ApiError('invalid_state_transition', error.message, { cause: error });
  }
  return undefined;
}

const STATE_WORDS = {
  queued: 'waiting to start',
  running: 'running',
  retrying: 'waiting to try again',
  verifying: 'being checked',
  succeeded: 'done',
  failed: 'failed',
  needs_user_action: 'waiting for you',
  canceled: 'canceled',
} as const satisfies Record<OperationStatus, string>;
