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
 * - a step found `running` was interrupted, so its result is read back as if it were unknown;
 * - a read-back decides only when it is current: one older than a revision already seen of the
 *   listing is stale and is followed by another read (with no freshness marker, a match must
 *   repeat in a later read);
 * - a listing id a send returned (a relist can issue a new one) is kept on the listing at once
 *   as its pending id, which every later step and operation targets until a read-back confirms
 *   it; an end also targets the older verified id, which may still be live, and succeeds only
 *   when every targeted id reads back ended.
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
import {
  confirmByReadBack,
  confirmEveryReadBack,
  remoteSnapshot,
  type Freshness,
  type ReadBackResult,
  type SuccessProof,
} from './evidence.ts';
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
  /** How a read-back shows it is current (the adapter's `readFreshness`). */
  freshness: 'revision' | 'none';
  /**
   * The marketplace listings the step targets, newest id first (see `listingTargets`); a step
   * succeeds only when every one of them reads back the desired state.
   */
  targets: Targets;
  /** The marketplace's display name, for messages. */
  name: string;
}

type Targets = readonly [ListingRef, ...ListingRef[]];

/** The newest revision seen per marketplace listing id: stored ones, then this step's. */
type SeenRevisions = Map<string, number>;

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
  const seen = storedRevisions(step.ctx);
  const result =
    step.type === 'send'
      ? await performSend(deps, step, seen, signal)
      : await performCheck(deps, step, seen, signal);
  await recordResult(deps, step, result, seen);
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
    const capabilities = adapter.capabilities(connection ?? undefined);
    const canReadBack = capabilities.verifyRead === 'api';
    const base = {
      listing,
      adapter,
      connection,
      desired,
      canReadBack,
      freshness: capabilities.readFreshness,
      targets: listingTargets(listing, desired),
      name,
    };
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

/**
 * The marketplace listings an operation targets: the newest known id, where a pending one (not
 * yet confirmed by a read-back) wins over the verified one. An end also targets the verified id
 * when a pending one exists, since either may still be live.
 */
function listingTargets(listing: ListingRow, desired: DesiredListingState): Targets {
  const ref = (externalListingId: string | null): ListingRef => ({
    listingId: listing.id,
    externalListingId,
    externalSku: listing.external_sku,
  });
  const pending = listing.pending_external_listing_id;
  const verified = listing.external_listing_id;
  if (pending === null) return [ref(verified)];
  if (desired.status === 'ended' && verified !== null) return [ref(pending), ref(verified)];
  return [ref(pending)];
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
  seen: SeenRevisions,
  signal: AbortSignal,
): Promise<StepResult> {
  const [primary, ...others] = step.ctx.targets;
  const results: [StepResult, ...StepResult[]] = [await sendTo(deps, step, primary, seen, signal)];
  for (const target of others) results.push(await sendTo(deps, step, target, seen, signal));
  return combineResults(step.ctx, results);
}

async function performCheck(
  deps: StepDependencies,
  step: Extract<Step, { type: 'check' }>,
  seen: SeenRevisions,
  signal: AbortSignal,
): Promise<StepResult> {
  const [primary, ...others] = step.ctx.targets;
  const results: [StepResult, ...StepResult[]] = [
    await checkTarget(deps, step, primary, seen, signal),
  ];
  for (const target of others) {
    results.push(await checkTarget(deps, step, target, seen, signal));
  }
  return combineResults(step.ctx, results);
}

/** Sends the operation to one targeted marketplace listing, reading it back first if needed. */
async function sendTo(
  deps: StepDependencies,
  step: Extract<Step, { type: 'send' }>,
  ref: ListingRef,
  seen: SeenRevisions,
  signal: AbortSignal,
): Promise<StepResult> {
  const { ctx } = step;

  if (step.precheck) {
    const read = await readOnce(deps, ctx, ref, signal);
    if (!read.ok) {
      return {
        resolution: { type: 'verify', error: cannotCheck(ctx.name), unknownResult: false },
        detail: { step: 'send', precheck: { error: read.error } },
      };
    }
    const comparison = compareReadBack(ctx, read.remote, seen, false);
    if (comparison.matches && read.remote.found) {
      return {
        resolution: { type: 'succeeded', proof: comparison.proof, remote: read.remote },
        detail: { step: 'send', precheck: { matches: true }, sent: false },
      };
    }
    // A stale or unrepeated read shows nothing for certain, so read again rather than send.
    const undecided = undecidedRead(ctx, comparison, false);
    if (undecided !== undefined) {
      return { resolution: undecided, detail: { step: 'send', precheck: comparison } };
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
      const target = { ...ref, externalListingId: learned ?? ref.externalListingId };
      // The read-back must not be older than the write it verifies.
      if (ctx.freshness === 'revision') {
        noteRevision(seen, target.externalListingId, outcome.revision);
      }
      const read = await readOnce(deps, ctx, target, signal);
      if (!read.ok) {
        return {
          resolution: { type: 'verify', error: cannotCheck(ctx.name), unknownResult: true },
          detail: { ...detail, readBack: { error: read.error } },
          ...withId,
        };
      }
      const comparison = compareReadBack(ctx, read.remote, seen, false);
      if (comparison.matches && read.remote.found) {
        return {
          resolution: { type: 'succeeded', proof: comparison.proof, remote: read.remote },
          detail,
          ...withId,
        };
      }
      return {
        resolution: undecidedRead(ctx, comparison, true) ?? {
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

/** Reads one targeted marketplace listing back to learn whether the desired state holds. */
async function checkTarget(
  deps: StepDependencies,
  step: Extract<Step, { type: 'check' }>,
  ref: ListingRef,
  seen: SeenRevisions,
  signal: AbortSignal,
): Promise<StepResult> {
  const { ctx } = step;
  const read = await readOnce(deps, ctx, ref, signal);
  if (!read.ok) {
    return {
      resolution: { type: 'verify', error: cannotCheck(ctx.name), unknownResult: false },
      detail: { step: 'check', readBack: { error: read.error } },
    };
  }
  // The step before this one read a match of every target and scheduled this read to repeat it.
  const previousReadMatched =
    ctx.op.status === 'verifying' && ctx.op.error_code === UNREPEATED_READ_CODE;
  const comparison = compareReadBack(ctx, read.remote, seen, previousReadMatched);
  if (comparison.matches && read.remote.found) {
    return {
      resolution: { type: 'succeeded', proof: comparison.proof, remote: read.remote },
      detail: { step: 'check' },
    };
  }
  const detail = { step: 'check', readBack: comparison.matches ? {} : comparison };
  const undecided = undecidedRead(ctx, comparison, false);
  if (undecided !== undefined) return { resolution: undecided, detail };
  const fields = comparison.matches ? [] : comparison.fields;
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

/**
 * Joins the results of a step's targets: it succeeds only when every target succeeded, and
 * otherwise takes the result that decides least (a failure, a read that decided nothing, a
 * resend, then a match still to repeat).
 */
function combineResults(
  ctx: StepContext,
  results: readonly [StepResult, ...StepResult[]],
): StepResult {
  const [primary, ...others] = results;
  if (others.length === 0) return primary;
  const detail = {
    step: primary.detail['step'],
    targets: results.map((result, index) => ({
      externalListingId: ctx.targets[index]?.externalListingId ?? null,
      ...result.detail,
    })),
  };
  const withId =
    primary.externalListingId === undefined ? {} : { externalListingId: primary.externalListingId };
  const resolutions = results.map((result) => result.resolution);
  const unknownResult = resolutions.some(
    (resolution) => resolution.type === 'verify' && resolution.unknownResult,
  );

  const decisive =
    resolutions.find((resolution) => resolution.type === 'failed') ??
    resolutions.find((resolution) => resolution.type === 'user') ??
    resolutions.find(
      (resolution) =>
        resolution.type === 'verify' && resolution.error.code !== UNREPEATED_READ_CODE,
    );
  if (decisive !== undefined) {
    return {
      resolution: decisive.type === 'verify' ? { ...decisive, unknownResult } : decisive,
      detail,
      ...withId,
    };
  }
  const retries = resolutions.filter((resolution) => resolution.type === 'retry');
  const [retry] = retries;
  if (retry !== undefined) {
    const retryAfterMs = Math.max(0, ...retries.map((resolution) => resolution.retryAfterMs ?? 0));
    return {
      resolution: {
        type: 'retry',
        error: retry.error,
        ...(retryAfterMs > 0 ? { retryAfterMs } : {}),
      },
      detail,
      ...withId,
    };
  }
  const repeat = resolutions.find((resolution) => resolution.type === 'verify');
  if (repeat !== undefined) {
    return { resolution: { ...repeat, unknownResult }, detail, ...withId };
  }

  const proofs: SuccessProof[] = [];
  for (const resolution of resolutions) {
    if (resolution.type !== 'succeeded') throw new Error('every target should have succeeded');
    proofs.push(resolution.proof);
  }
  const [first, ...rest] = proofs;
  if (primary.resolution.type !== 'succeeded' || first === undefined) {
    throw new Error('the primary target should have succeeded');
  }
  return {
    resolution: {
      type: 'succeeded',
      proof: confirmEveryReadBack([first, ...rest]),
      remote: primary.resolution.remote,
    },
    detail,
    ...withId,
  };
}

/**
 * Compares a read-back with the desired state under the adapter's freshness rule, and notes the
 * read's revision as seen.
 */
function compareReadBack(
  ctx: StepContext,
  remote: RemoteListingState,
  seen: SeenRevisions,
  previousReadMatched: boolean,
): ReadBackResult {
  const freshness: Freshness =
    ctx.freshness === 'revision'
      ? {
          kind: 'revision',
          newestSeen: remote.found ? (seen.get(remote.externalListingId) ?? null) : null,
        }
      : { kind: 'repeat', previousReadMatched };
  const comparison = confirmByReadBack(ctx.desired, remote, freshness);
  if (ctx.freshness === 'revision' && remote.found) {
    noteRevision(seen, remote.externalListingId, remote.revision);
  }
  return comparison;
}

/** A read that decides nothing (stale, or a match still to repeat): read again later. */
function undecidedRead(
  ctx: StepContext,
  comparison: ReadBackResult,
  unknownResult: boolean,
): Extract<Resolution, { type: 'verify' }> | undefined {
  if (comparison.matches) return undefined;
  switch (comparison.reason) {
    case 'stale':
      return { type: 'verify', error: notCurrent(ctx.name), unknownResult };
    case 'unrepeated':
      return { type: 'verify', error: confirmingAgain(ctx.name), unknownResult };
    case 'not_found':
    case 'mismatch':
    case 'nothing_desired':
      return undefined;
    default:
      return assertNever(comparison.reason, 'read-back reason');
  }
}

/** The revisions stored for the listing's verified and pending ids, when they are used. */
function storedRevisions(ctx: StepContext): SeenRevisions {
  const seen: SeenRevisions = new Map();
  if (ctx.freshness !== 'revision') return seen;
  noteRevision(seen, ctx.listing.external_listing_id, ctx.listing.remote_revision);
  noteRevision(seen, ctx.listing.pending_external_listing_id, ctx.listing.pending_remote_revision);
  return seen;
}

function revisionOf(seen: SeenRevisions, externalListingId: string | null): number | undefined {
  return externalListingId === null ? undefined : seen.get(externalListingId);
}

function noteRevision(
  seen: SeenRevisions,
  externalListingId: string | null,
  revision: number | null | undefined,
): void {
  if (externalListingId === null || revision === null || revision === undefined) return;
  const known = seen.get(externalListingId);
  if (known === undefined || revision > known) seen.set(externalListingId, revision);
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

async function recordResult(
  deps: StepDependencies,
  step: Step,
  result: StepResult,
  seen: SeenRevisions,
): Promise<void> {
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

    // A listing id the marketplace returned becomes the listing's pending id at once, so every
    // later step and operation on the listing reaches it, verified or not.
    const learned = result.externalListingId;
    let pendingId = ctx.listing.pending_external_listing_id;
    if (
      learned !== undefined &&
      learned !== ctx.listing.external_listing_id &&
      learned !== pendingId
    ) {
      if (await externalIdTaken(trx, ctx.listing, learned)) {
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
        .set({ pending_external_listing_id: learned, pending_remote_revision: null })
        .where('account_id', '=', op.account_id)
        .where('id', '=', op.listing_id)
        .execute();
      pendingId = learned;
    }
    // The newest revisions seen of the listing's ids, kept for every later read.
    const verifiedRevision = revisionOf(seen, ctx.listing.external_listing_id);
    const pendingRevision = revisionOf(seen, pendingId);
    if (verifiedRevision !== undefined || pendingRevision !== undefined) {
      await trx
        .updateTable('marketplace_listing')
        .set({
          ...(verifiedRevision === undefined
            ? {}
            : {
                remote_revision: sql<number>`greatest(remote_revision, ${verifiedRevision}::bigint)`,
              }),
          ...(pendingRevision === undefined
            ? {}
            : {
                pending_remote_revision: sql<number>`greatest(pending_remote_revision, ${pendingRevision}::bigint)`,
              }),
        })
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

/**
 * Records what the marketplace confirmed on the listing row. A confirmed pending id becomes the
 * verified one and keeps its revisions; an id new to the row starts its own.
 */
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
      remote_revision: sql<number | null>`
        case
          when external_listing_id = ${remote.externalListingId}
            then greatest(remote_revision, ${remote.revision}::bigint)
          when pending_external_listing_id = ${remote.externalListingId}
            then greatest(pending_remote_revision, ${remote.revision}::bigint)
          else ${remote.revision}::bigint
        end`,
      pending_external_listing_id: sql<string | null>`
        case when pending_external_listing_id = ${remote.externalListingId}
          then null else pending_external_listing_id end`,
      pending_remote_revision: sql<number | null>`
        case when pending_external_listing_id = ${remote.externalListingId}
          then null else pending_remote_revision end`,
      last_verified_at: sql<Date>`now()`,
      ...(active
        ? { listed_at: sql<Date>`coalesce(listed_at, now())`, ended_at: null }
        : { ended_at: sql<Date>`coalesce(ended_at, now())` }),
    })
    .where('account_id', '=', listing.account_id)
    .where('id', '=', listing.id)
    .execute();
}

/**
 * Whether another of the account's listings is already linked to this marketplace listing, by
 * its verified or its pending id.
 */
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
    .where((eb) =>
      eb.or([
        eb('external_listing_id', '=', externalListingId),
        eb('pending_external_listing_id', '=', externalListingId),
      ]),
    )
    .where('id', '<>', listing.id)
    .executeTakeFirst();
  return other !== undefined;
}

// Helpers ---------------------------------------------------------------------------------

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

/** Set on a `verifying` operation whose last read matched without a freshness marker. */
const UNREPEATED_READ_CODE = 'confirming';

function confirmingAgain(name: string): OperationError {
  return {
    code: UNREPEATED_READ_CODE,
    message: `Listora is checking the listing on ${name} once more to be sure.`,
  };
}

function notCurrent(name: string): OperationError {
  return {
    code: 'stale_read',
    message: `${name} showed an older version of the listing. Listora is checking again.`,
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
