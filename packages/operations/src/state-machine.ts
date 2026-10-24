/**
 * The operation state machine (docs/architecture.md section 6). Every status change goes
 * through `transitionOperation` (transitions.ts), which checks it against this table.
 *
 *   queued ──▶ running ──▶ succeeded            (read-back confirmed the desired state)
 *     │           ├──────▶ retrying ──▶ running  (temporary failure; next attempt scheduled)
 *     │           ├──────▶ verifying ─▶ succeeded | retrying | verifying | failed
 *     │           ├──────▶ needs_user_action ──▶ succeeded (the user confirmed) | canceled
 *     │           └──────▶ failed ──▶ queued     (the user taps Retry)
 *     └──▶ canceled
 *
 * `running` means a step is in progress and its request may already be on its way, so it can
 * neither be canceled nor retried until the step's result is recorded.
 */
import type { OperationStatus } from '@listora/db';

export const OPERATION_TRANSITIONS = {
  queued: ['running', 'failed', 'canceled'],
  running: ['succeeded', 'retrying', 'verifying', 'needs_user_action', 'failed'],
  retrying: ['running', 'failed', 'canceled'],
  verifying: ['succeeded', 'retrying', 'verifying', 'failed'],
  needs_user_action: ['succeeded', 'canceled'],
  failed: ['queued'],
  succeeded: [],
  canceled: [],
} as const satisfies Record<OperationStatus, readonly OperationStatus[]>;

export function canTransition(from: OperationStatus, to: OperationStatus): boolean {
  return (OPERATION_TRANSITIONS[from] as readonly OperationStatus[]).includes(to);
}

/**
 * Statuses in which an operation is not finished. A newer operation on the same listing waits
 * until every older one has left these statuses, so operations apply in the order they were
 * created even when an older one is waiting to retry. The one exception is a delist (an end or
 * mark-sold): it supersedes older operations waiting for the user instead (executor.ts).
 */
export const UNFINISHED_STATUSES = [
  'queued',
  'running',
  'retrying',
  'verifying',
  'needs_user_action',
] as const satisfies readonly OperationStatus[];

/** Statuses after which the engine does nothing more unless the user retries. */
export const SETTLED_STATUSES = [
  'succeeded',
  'failed',
  'canceled',
] as const satisfies readonly OperationStatus[];

/** Statuses that have a scheduled job: the next step runs at `next_attempt_at`. */
export const SCHEDULED_STATUSES = [
  'queued',
  'retrying',
  'verifying',
] as const satisfies readonly OperationStatus[];

export function isSettled(status: OperationStatus): boolean {
  return (SETTLED_STATUSES as readonly OperationStatus[]).includes(status);
}

export function isScheduled(status: OperationStatus): boolean {
  return (SCHEDULED_STATUSES as readonly OperationStatus[]).includes(status);
}
