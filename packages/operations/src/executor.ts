/**
 * Runs one step of an operation (docs/architecture.md section 6). A job runs one step:
 *
 * 1. **Claim** (transaction): lock the operation and decide the step. Before a step can send
 *    anything, the operation is marked `running` and committed, so a step interrupted by a
 *    crash is detectable afterwards. No transaction stays open during marketplace calls.
 * 2. **Call** (no transaction): talk to the marketplace through its adapter, with a deadline.
 * 3. **Record** (transaction): lock the operation again, check it is still exactly as claimed
 *    (otherwise another worker took over and this result is discarded), and apply the result.
 *
 * Success is recorded only with a `SuccessProof` from a read-back (evidence.ts). The rules that
 * keep re-execution idempotent:
 *
 * - an `unknown` result (timeout after send, an adapter crash, a lost connection) is followed by
 *   a read-back, never by a blind resend;
 * - an operation that was sent before is read back first on every later attempt, and succeeds
 *   without sending again if the change already took effect;
 * - a step found `running` was interrupted, so its result is read back as if it were unknown.
 */
import type { Selectable } from 'kysely';
import { sql } from 'kysely';

import {
  jsonb,
  type Db,
  type DbTransaction,
  type MarketplaceListingTable,
  type OperationStatus,
} from '@listora/db';
import {
  MARKETPLACE_NAMES,
  type AdapterLookup,
  type ConnectionRef,
  type DesiredListingState,
  type ListingRef,
  type MarketplaceAdapter,
  type OperationRequest,
  type Outcome,
  type RemoteListingState,
  type UserTaskSpec,
} from '@listora/marketplaces';
import { assertNever, type Logger } from '@listora/shared';

import { validateDesiredState } from './desired.ts';
import { confirmByReadBack, remoteSnapshot, type SuccessProof } from './evidence.ts';
import type { OperationJobPayload } from './jobs.ts';
import { scheduleOperationJob } from './jobs.ts';
import { createdBefore } from './ordering.ts';
import { delayAfterAttempt, maxAttempts, type RetryPolicy } from './policy.ts';
import { UNFINISHED_STATUSES } from './state-machine.ts';
import {
  operationPriority,
  transitionOperation,
  type OperationError,
  type OperationRow,
} from './transitions.ts';

export interface StepDependencies {
  db: Db;
  adapters: AdapterLookup;
  logger: Logger;
  policy: RetryPolicy;
  /** Deadline for one adapter call; a send that misses it has an unknown result. */
  callTimeoutMs: number;
  /** How long an operation waiting behind an older one on its listing sleeps between checks. */
  blockedRecheckMs: number;
}

type ListingRow = Selectable<MarketplaceListingTable>;
type FoundRemote = Extract<RemoteListingState, { found: true }>;

interface StepContext {
  /** The operation as the claim left it; the record phase requires it unchanged. */
  op: OperationRow;
  listing: ListingRow;
  adapter: MarketplaceAdapter;
  connection: ConnectionRef | null;
  desired: DesiredListingState;
  canReadBack: boolean;
  /** The marketplace's display name, for messages. */
  name: string;
}

type Step =
  /** Send the operation (after reading the listing back first, if it was sent before). */
  | { type: 'send'; ctx: StepContext; precheck: boolean; attempt: number }
  /** Read the listing back to learn whether the desired state holds. */
  | { type: 'check'; ctx: StepContext; attempt: number };

type Resolution =
  | { type: 'succeeded'; proof: SuccessProof; remote: FoundRemote }
  /** Send again later, if attempts remain. */
  | { type: 'retry'; error: OperationError; retryAfterMs?: number }
  /**
   * Read the listing back later. With `unknownResult`, a send may have taken effect, so the
   * read-back happens even when no attempts remain.
   */
  | { type: 'verify'; error: OperationError; unknownResult: boolean }
  | { type: 'failed'; error: OperationError }
  | { type: 'user'; task: UserTaskSpec };

interface StepResult {
  resolution: Resolution;
  /** A listing id the marketplace returned, kept even when the result is not yet verified. */
  externalListingId?: string;
  detail: Record<string, unknown>;
}

/** Runs the next step of an operation. Throws only for database failures and bugs. */
export async function runOperationStep(
  deps: StepDependencies,
  payload: OperationJobPayload,
  signal: AbortSignal,
): Promise<void> {
  const step = await claimStep(deps, payload);
  if (step === null) return;
  const result =
    step.type === 'send'
      ? await performSend(deps, step, signal)
      : await performCheck(deps, step, signal);
  await recordResult(deps, step, result);
}

// Claim -----------------------------------------------------------------------------------

async function claimStep(
  deps: StepDependencies,
  payload: OperationJobPayload,
): Promise<Step | null> {
  return deps.db.transaction().execute(async (trx) => {
    const op = await trx
      .selectFrom('marketplace_operation')
      .selectAll()
      .where('account_id', '=', payload.accountId)
      .where('id', '=', payload.operationId)
      .forUpdate()
      .executeTakeFirst();
    const log = deps.logger.child({
      accountId: payload.accountId,
      operationId: payload.operationId,
    });
    if (op === undefined) {
      log.warn('operation job has no operation; skipping');
      return null;
    }
    switch (op.status) {
      case 'succeeded':
      case 'failed':
      case 'canceled':
      case 'needs_user_action':
        log.debug({ status: op.status }, 'operation has no step to run');
        return null;
      case 'queued':
      case 'retrying':
      case 'running':
      case 'verifying':
        break;
      default:
        return assertNever(op.status, 'operation status');
    }

    const listing = await trx
      .selectFrom('marketplace_listing')
      .selectAll()
      .where('account_id', '=', op.account_id)
      .where('id', '=', op.listing_id)
      .executeTakeFirstOrThrow();
    const name = MARKETPLACE_NAMES[listing.marketplace];
    const adapter = deps.adapters(listing.marketplace);
    if (adapter === undefined) {
      // Without an adapter nothing can be sent or read back. An operation that may already
      // have been sent fails as unconfirmed, so Retry knows to read it back first.
      const mayHaveBeenSent = op.status === 'running' || op.status === 'verifying';
      await transitionOperation(trx, op, {
        to: 'failed',
        error: mayHaveBeenSent
          ? cannotConfirm(name)
          : { code: 'marketplace_unavailable', message: `Listora can't connect to ${name} yet.` },
      });
      return null;
    }
    let desired: DesiredListingState;
    try {
      desired = validateDesiredState(op.kind, op.desired);
    } catch (error) {
      await transitionOperation(
        trx,
        op,
        {
          to: 'failed',
          error: { code: 'invalid_operation', message: `This change can't be sent to ${name}.` },
        },
        { reason: error instanceof Error ? error.message : String(error) },
      );
      return null;
    }
    const connection = await loadConnection(trx, listing);
    const canReadBack = adapter.capabilities(connection ?? undefined).verifyRead === 'api';
    const base = { listing, adapter, connection, desired, canReadBack, name };
    const max = maxAttempts(deps.policy);

    if (op.status === 'running') {
      // The step that set `running` never recorded its result: its worker stopped mid-step.
      const interrupted = {
        code: 'interrupted',
        message: `Listora was interrupted and is checking the listing on ${name}.`,
      };
      if (canReadBack) {
        await transitionOperation(
          trx,
          op,
          { to: 'verifying', delayMs: 0, error: interrupted },
          { recovered: true },
        );
      } else if (op.attempts < max) {
        // Without a read-back the step had no remote effect (assisted steps only create a
        // user task, atomically with their result), so it simply runs again.
        await transitionOperation(
          trx,
          op,
          { to: 'retrying', delayMs: 0, error: interrupted },
          { recovered: true },
        );
      } else {
        await transitionOperation(trx, op, {
          to: 'failed',
          error: { code: 'interrupted', message: 'Listora was interrupted. Tap Retry.' },
        });
      }
      log.warn({ attempt: op.attempts }, 'recovered an interrupted operation step');
      return null;
    }

    if (op.status === 'verifying') {
      if (!canReadBack) {
        await transitionOperation(trx, op, {
          to: 'failed',
          error: cannotConfirm(name),
        });
        return null;
      }
      return { type: 'check', ctx: { op, ...base }, attempt: op.attempts + 1 };
    }

    // queued or retrying: a new attempt, once every older operation on the listing is done.
    if (await hasOlderUnfinishedOperation(trx, op)) {
      await scheduleOperationJob(trx, {
        accountId: op.account_id,
        operationId: op.id,
        listingId: op.listing_id,
        priority: operationPriority(op),
        runAt: new Date(Date.now() + deps.blockedRecheckMs),
      });
      log.debug('operation waits for an older operation on its listing');
      return null;
    }
    if (op.kind === 'verify' && !canReadBack) {
      await transitionOperation(trx, op, {
        to: 'failed',
        error: { code: 'cannot_verify', message: `Listora can't check ${name} listings itself.` },
      });
      return null;
    }
    if (op.attempts >= max) {
      await transitionOperation(trx, op, {
        to: 'failed',
        error: {
          code: op.error_code ?? 'attempts_exhausted',
          message: op.error_message ?? `Listora tried ${String(max)} times.`,
        },
      });
      return null;
    }

    const precheck = op.kind !== 'verify' && canReadBack && (await wasSentBefore(trx, op));
    const running = await transitionOperation(
      trx,
      op,
      { to: 'running' },
      { step: op.kind === 'verify' ? 'check' : 'send', precheck },
    );
    const ctx = { op: running, ...base };
    return op.kind === 'verify'
      ? { type: 'check', ctx, attempt: running.attempts }
      : { type: 'send', ctx, precheck, attempt: running.attempts };
  });
}

async function loadConnection(
  trx: DbTransaction,
  listing: ListingRow,
): Promise<ConnectionRef | null> {
  if (listing.connection_id === null) return null;
  const connection = await trx
    .selectFrom('marketplace_connection')
    .select(['id', 'mode'])
    .where('account_id', '=', listing.account_id)
    .where('id', '=', listing.connection_id)
    .executeTakeFirst();
  return connection ?? null;
}

/** Whether an older operation on the same listing is still unfinished (FIFO per listing). */
async function hasOlderUnfinishedOperation(trx: DbTransaction, op: OperationRow): Promise<boolean> {
  const older = await trx
    .selectFrom('marketplace_operation')
    .select('id')
    .where('account_id', '=', op.account_id)
    .where('listing_id', '=', op.listing_id)
    .where('status', 'in', UNFINISHED_STATUSES)
    .where(createdBefore(op))
    .limit(1)
    .executeTakeFirst();
  return older !== undefined;
}

/** Whether any earlier step started sending this operation (its history has a `running`). */
async function wasSentBefore(trx: DbTransaction, op: OperationRow): Promise<boolean> {
  const event = await trx
    .selectFrom('operation_event')
    .select('id')
    .where('account_id', '=', op.account_id)
    .where('operation_id', '=', op.id)
    .where('to_status', '=', 'running')
    .limit(1)
    .executeTakeFirst();
  return event !== undefined;
}

// Call ------------------------------------------------------------------------------------

async function performSend(
  deps: StepDependencies,
  step: Extract<Step, { type: 'send' }>,
  signal: AbortSignal,
): Promise<StepResult> {
  const { ctx } = step;
  const ref = listingRef(ctx.listing);

  if (step.precheck) {
    const read = await readOnce(deps, ctx, ref, signal);
    if (!read.ok) {
      return {
        resolution: { type: 'verify', error: cannotCheck(ctx.name), unknownResult: false },
        detail: { step: 'send', precheck: { error: read.error } },
      };
    }
    const comparison = confirmByReadBack(ctx.desired, read.remote);
    if (comparison.matches && read.remote.found) {
      return {
        resolution: { type: 'succeeded', proof: comparison.proof, remote: read.remote },
        detail: { step: 'send', precheck: { matches: true }, sent: false },
      };
    }
  }

  const kind = ctx.op.kind;
  if (kind === 'verify') throw new Error('verify operations are checked, never sent');
  const request: OperationRequest = {
    operationId: ctx.op.id,
    kind,
    idempotencyKey: ctx.op.idempotency_key,
    attempt: step.attempt,
    desired: ctx.desired,
    listing: ref,
  };
  const outcome = await executeOnce(deps, ctx, request, signal);
  const detail: Record<string, unknown> = {
    step: 'send',
    ...(step.precheck ? { precheck: { matches: false } } : {}),
    outcome: outcomeSummary(outcome),
    ...(outcome.excerpt === undefined ? {} : { excerpt: outcome.excerpt }),
  };

  switch (outcome.type) {
    case 'confirmed': {
      const learned = outcome.externalListingId;
      const withId = learned === undefined ? {} : { externalListingId: learned };
      if (!ctx.canReadBack) {
        return {
          resolution: { type: 'failed', error: cannotConfirm(ctx.name) },
          detail: { ...detail, reason: 'confirmed without a read-back capability' },
          ...withId,
        };
      }
      const read = await readOnce(
        deps,
        ctx,
        { ...ref, externalListingId: learned ?? ref.externalListingId },
        signal,
      );
      if (!read.ok) {
        return {
          resolution: { type: 'verify', error: cannotCheck(ctx.name), unknownResult: true },
          detail: { ...detail, readBack: { error: read.error } },
          ...withId,
        };
      }
      const comparison = confirmByReadBack(ctx.desired, read.remote);
      if (comparison.matches && read.remote.found) {
        return {
          resolution: { type: 'succeeded', proof: comparison.proof, remote: read.remote },
          detail,
          ...withId,
        };
      }
      return {
        resolution: {
          type: 'verify',
          error: notShown(ctx.name, comparison.matches ? [] : comparison.fields),
          unknownResult: true,
        },
        detail: { ...detail, readBack: comparison.matches ? {} : comparison },
        ...withId,
      };
    }
    case 'rejected':
      return {
        resolution: {
          type: 'failed',
          error: {
            code: outcome.code,
            message:
              outcome.fixHint === undefined
                ? outcome.message
                : `${outcome.message} ${outcome.fixHint}`,
          },
        },
        detail,
      };
    case 'transient':
      return {
        resolution: {
          type: 'retry',
          error: { code: outcome.code, message: outcome.message },
          ...(outcome.retryAfterMs === undefined ? {} : { retryAfterMs: outcome.retryAfterMs }),
        },
        detail,
      };
    case 'unknown':
      return {
        resolution: ctx.canReadBack
          ? {
              type: 'verify',
              error: { code: outcome.code, message: outcome.message },
              unknownResult: true,
            }
          : { type: 'failed', error: cannotConfirm(ctx.name) },
        detail,
      };
    case 'pendingUser':
      return { resolution: { type: 'user', task: outcome.task }, detail };
    default:
      return assertNever(outcome, 'adapter outcome');
  }
}

async function performCheck(
  deps: StepDependencies,
  step: Extract<Step, { type: 'check' }>,
  signal: AbortSignal,
): Promise<StepResult> {
  const { ctx } = step;
  const read = await readOnce(deps, ctx, listingRef(ctx.listing), signal);
  if (!read.ok) {
    return {
      resolution: { type: 'verify', error: cannotCheck(ctx.name), unknownResult: false },
      detail: { step: 'check', readBack: { error: read.error } },
    };
  }
  const comparison = confirmByReadBack(ctx.desired, read.remote);
  if (comparison.matches && read.remote.found) {
    return {
      resolution: { type: 'succeeded', proof: comparison.proof, remote: read.remote },
      detail: { step: 'check' },
    };
  }
  const fields = comparison.matches ? [] : comparison.fields;
  const detail = { step: 'check', readBack: comparison.matches ? {} : comparison };
  if (ctx.op.kind === 'verify') {
    return {
      resolution: {
        type: 'failed',
        error: {
          code: 'state_mismatch',
          message: `The listing on ${ctx.name} doesn't match Listora${describeFields(fields)}.`,
        },
      },
      detail,
    };
  }
  // Read back and not applied: sending again is no longer blind.
  return { resolution: { type: 'retry', error: notShown(ctx.name, fields) }, detail };
}

type ReadResult = { ok: true; remote: RemoteListingState } | { ok: false; error: string };

async function readOnce(
  deps: StepDependencies,
  ctx: StepContext,
  ref: ListingRef,
  signal: AbortSignal,
): Promise<ReadResult> {
  try {
    const result = await withDeadline(deps.callTimeoutMs, signal, (callSignal) =>
      ctx.adapter.readListing(ref, { signal: callSignal, connection: ctx.connection }),
    );
    if (!result.done) return { ok: false, error: 'timeout' };
    return { ok: true, remote: result.value };
  } catch (error) {
    deps.logger.warn({ err: error, operationId: ctx.op.id }, 'reading the listing back failed');
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function executeOnce(
  deps: StepDependencies,
  ctx: StepContext,
  request: OperationRequest,
  signal: AbortSignal,
): Promise<Outcome> {
  try {
    const result = await withDeadline(deps.callTimeoutMs, signal, (callSignal) =>
      ctx.adapter.execute(request, { signal: callSignal, connection: ctx.connection }),
    );
    if (!result.done) {
      return { type: 'unknown', code: 'timeout', message: `${ctx.name} didn't answer in time.` };
    }
    return result.value;
  } catch (error) {
    // An adapter must return outcomes, not throw; the request may have been sent regardless.
    deps.logger.error({ err: error, operationId: ctx.op.id }, 'marketplace adapter threw');
    return {
      type: 'unknown',
      code: 'adapter_error',
      message: `Listora lost track of the request to ${ctx.name}.`,
    };
  }
}

/** Runs `call` with its own abort signal, aborted at the deadline or when `outer` aborts. */
async function withDeadline<T>(
  timeoutMs: number,
  outer: AbortSignal,
  call: (signal: AbortSignal) => Promise<T>,
): Promise<{ done: true; value: T } | { done: false }> {
  const controller = new AbortController();
  const onAbort = (): void => {
    controller.abort(outer.reason);
  };
  outer.addEventListener('abort', onAbort, { once: true });
  if (outer.aborted) onAbort();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<{ done: false }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error('deadline exceeded'));
      resolve({ done: false });
    }, timeoutMs);
  });
  const work = Promise.resolve()
    .then(() => call(controller.signal))
    .then((value) => ({ done: true as const, value }));
  // The call can still settle after the deadline; nothing waits for it then.
  work.catch(() => undefined);
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
    outer.removeEventListener('abort', onAbort);
  }
}

// Record ----------------------------------------------------------------------------------

async function recordResult(deps: StepDependencies, step: Step, result: StepResult): Promise<void> {
  const { ctx } = step;
  const log = deps.logger.child({ accountId: ctx.op.account_id, operationId: ctx.op.id });
  await deps.db.transaction().execute(async (trx) => {
    const op = await trx
      .selectFrom('marketplace_operation')
      .selectAll()
      .where('account_id', '=', ctx.op.account_id)
      .where('id', '=', ctx.op.id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (op.status !== ctx.op.status || op.attempts !== ctx.op.attempts) {
      log.warn(
        { claimed: ctx.op.status, current: op.status, attempt: op.attempts },
        'operation changed during the step; its result is discarded',
      );
      return;
    }

    if (result.externalListingId !== undefined && ctx.listing.external_listing_id === null) {
      if (await externalIdTaken(trx, ctx.listing, result.externalListingId)) {
        await transitionOperation(
          trx,
          op,
          { to: 'failed', attempts: step.attempt, error: linkedElsewhere(ctx.name) },
          result.detail,
        );
        return;
      }
      await trx
        .updateTable('marketplace_listing')
        .set({ external_listing_id: result.externalListingId })
        .where('account_id', '=', op.account_id)
        .where('id', '=', op.listing_id)
        .execute();
    }

    const to = await applyResolution(deps, trx, step, op, result);
    log.info(
      { kind: op.kind, from: op.status, to, attempt: step.attempt },
      'operation step recorded',
    );
  });
}

async function applyResolution(
  deps: StepDependencies,
  trx: DbTransaction,
  step: Step,
  op: OperationRow,
  result: StepResult,
): Promise<OperationStatus> {
  const { ctx } = step;
  const { resolution, detail } = result;
  const attempts = step.attempt;
  const attemptsLeft = attempts < maxAttempts(deps.policy);

  switch (resolution.type) {
    case 'succeeded': {
      const { remote } = resolution;
      if (
        remote.externalListingId !== ctx.listing.external_listing_id &&
        (await externalIdTaken(trx, ctx.listing, remote.externalListingId))
      ) {
        await transitionOperation(
          trx,
          op,
          { to: 'failed', attempts, error: linkedElsewhere(ctx.name) },
          detail,
        );
        return 'failed';
      }
      await transitionOperation(
        trx,
        op,
        { to: 'succeeded', attempts, proof: resolution.proof },
        detail,
      );
      await applyVerifiedListing(trx, ctx.listing, remote);
      return 'succeeded';
    }
    case 'retry': {
      if (!attemptsLeft) {
        await transitionOperation(
          trx,
          op,
          { to: 'failed', attempts, error: resolution.error },
          detail,
        );
        return 'failed';
      }
      const delayMs = delayAfterAttempt(deps.policy, attempts, resolution.retryAfterMs);
      await transitionOperation(
        trx,
        op,
        { to: 'retrying', attempts, delayMs, error: resolution.error },
        detail,
      );
      return 'retrying';
    }
    case 'verify': {
      if (!attemptsLeft && !(resolution.unknownResult && step.type === 'send')) {
        await transitionOperation(
          trx,
          op,
          { to: 'failed', attempts, error: cannotConfirm(ctx.name) },
          { ...detail, lastError: resolution.error },
        );
        return 'failed';
      }
      const delayMs = delayAfterAttempt(deps.policy, attempts);
      await transitionOperation(
        trx,
        op,
        { to: 'verifying', attempts, delayMs, error: resolution.error },
        detail,
      );
      return 'verifying';
    }
    case 'failed':
      await transitionOperation(
        trx,
        op,
        { to: 'failed', attempts, error: resolution.error },
        detail,
      );
      return 'failed';
    case 'user': {
      await transitionOperation(trx, op, { to: 'needs_user_action' }, detail);
      await trx
        .insertInto('user_task')
        .values({
          account_id: op.account_id,
          kind: resolution.task.kind,
          item_id: ctx.listing.item_id,
          listing_id: ctx.listing.id,
          operation_id: op.id,
          delist_run_id: op.delist_run_id,
          urgency: op.origin === 'auto_delist' ? 'urgent' : 'normal',
          deep_link: resolution.task.deepLink,
          payload: jsonb(resolution.task.payload),
        })
        .execute();
      return 'needs_user_action';
    }
    default:
      return assertNever(resolution, 'step resolution');
  }
}

/** Records what the marketplace confirmed on the listing row. */
async function applyVerifiedListing(
  trx: DbTransaction,
  listing: ListingRow,
  remote: FoundRemote,
): Promise<void> {
  const active = remote.status === 'active';
  await trx
    .updateTable('marketplace_listing')
    .set({
      status: remote.status,
      external_listing_id: remote.externalListingId,
      external_url: remote.externalUrl,
      remote_snapshot: jsonb(remoteSnapshot(remote)),
      last_verified_at: sql<Date>`now()`,
      ...(active
        ? { listed_at: sql<Date>`coalesce(listed_at, now())`, ended_at: null }
        : { ended_at: sql<Date>`coalesce(ended_at, now())` }),
    })
    .where('account_id', '=', listing.account_id)
    .where('id', '=', listing.id)
    .execute();
}

/** Whether another of the account's listings is already linked to this marketplace listing. */
async function externalIdTaken(
  trx: DbTransaction,
  listing: ListingRow,
  externalListingId: string,
): Promise<boolean> {
  const other = await trx
    .selectFrom('marketplace_listing')
    .select('id')
    .where('account_id', '=', listing.account_id)
    .where('marketplace', '=', listing.marketplace)
    .where('external_listing_id', '=', externalListingId)
    .where('id', '<>', listing.id)
    .executeTakeFirst();
  return other !== undefined;
}

// Helpers ---------------------------------------------------------------------------------

function listingRef(listing: ListingRow): ListingRef {
  return {
    listingId: listing.id,
    externalListingId: listing.external_listing_id,
    externalSku: listing.external_sku,
  };
}

function outcomeSummary(outcome: Outcome): Record<string, unknown> {
  switch (outcome.type) {
    case 'confirmed':
    case 'pendingUser':
      return { type: outcome.type };
    case 'rejected':
    case 'transient':
    case 'unknown':
      return { type: outcome.type, code: outcome.code };
    default:
      return assertNever(outcome, 'adapter outcome');
  }
}

const FIELD_WORDS = {
  status: 'status',
  title: 'title',
  description: 'description',
  priceCents: 'price',
  currency: 'currency',
} as const satisfies Record<keyof DesiredListingState, string>;

function describeFields(fields: readonly (keyof DesiredListingState)[]): string {
  return fields.length === 0 ? '' : ` (${fields.map((field) => FIELD_WORDS[field]).join(', ')})`;
}

function notShown(name: string, fields: readonly (keyof DesiredListingState)[]): OperationError {
  return fields.length === 0
    ? { code: 'not_applied', message: `${name} doesn't show the change.` }
    : {
        code: 'read_back_mismatch',
        message: `${name} doesn't show the change${describeFields(fields)}.`,
      };
}

function cannotCheck(name: string): OperationError {
  return { code: 'read_failed', message: `Listora couldn't check the listing on ${name}.` };
}

function cannotConfirm(name: string): OperationError {
  return {
    code: 'unconfirmed',
    message: `Listora couldn't confirm the change with ${name}. Check the listing on ${name}, then tap Retry.`,
  };
}

function linkedElsewhere(name: string): OperationError {
  return {
    code: 'listing_conflict',
    message: `This ${name} listing is already linked to another Listora listing.`,
  };
}
