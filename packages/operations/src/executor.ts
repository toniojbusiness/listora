/**
 * Runs one step of an operation (docs/features/operations.md). A job runs one step:
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
 *   one that nothing can read back fails as unconfirmed if this or any earlier step of the
 *   operation could have gone through the API, and only a purely assisted one runs again;
 * - a read-back decides only when it is current: one older than a revision already seen of the
 *   listing is stale and is followed by another read (with no freshness marker, a match must
 *   repeat in a later read);
 * - a listing id a send returned (a relist can issue a new one) is kept on the listing at once
 *   as its pending id, which every later step and operation targets until a read-back confirms
 *   it; an end also targets the older verified id, which may still be live, and succeeds only
 *   when every targeted id reads back ended.
 *
 * Each operation runs in the mode its capability flag gives it under the listing's connection
 * (`operationMode`): an `api` or `automation` operation succeeds only by a read-back (through the
 * API, or through the automated browser session), an `assisted` one only by the user's
 * confirmation (an adapter answer other than a user task cannot finish it), and an `unsupported`
 * one fails without being sent. An automated step that meets a check it must not pass (a CAPTCHA,
 * a bot check, a login check) falls back to the user: its adapter answers with the assisted task,
 * and only the user's confirmation finishes it. A send builds the payload from the operation's
 * listing content with the adapter's pure builder, and sends nothing the adapter's own
 * validation refuses.
 *
 * Automated steps need a browser, which only the browser runner has (decision D1). A worker that
 * claims one hands its job over to the runner's task (`AUTOMATION_OPERATION_TASK`) on the same
 * listing queue, without counting an attempt, and tells the host so it can start the runner;
 * the runner runs the step with the same rules.
 *
 * Operations on a listing apply in creation order, with one exception: an end or mark-sold never
 * waits behind an older operation that waits for the user (an assisted edit nobody answered, say).
 * It closes those, and the operations queued behind them that never went through the API, as
 * superseded, and goes ahead, so a delist after a sale is never stuck.
 */
import type { Selectable } from 'kysely';
import { sql } from 'kysely';

import {
  inTransaction,
  jsonb,
  type DbExecutor,
  type DbTransaction,
  type ExecutionLocation,
  type MarketplaceListingTable,
  type OperationStatus,
} from '@listora/db';
import {
  isContentKind,
  MARKETPLACE_NAMES,
  operationMode,
  parseListingContent,
  readBackState,
  unsupportedMessage,
  type AdapterLookup,
  type ConnectionRef,
  type DesiredListingState,
  type ListingContent,
  type ListingPayload,
  type ListingRef,
  type MarketplaceAdapter,
  type OperationMode,
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
import { AUTOMATION_OPERATION_TASK, removeOperationJob, scheduleOperationJob } from './jobs.ts';
import { wasSentThroughApi } from './history.ts';
import { createdBefore } from './ordering.ts';
import { syncItemListedStatus } from './item-status.ts';
import {
  DEFAULT_PHONE_QUEUE,
  PHONE_UNAVAILABLE_ERROR,
  phoneWorkOf,
  queueOperationForPhone,
  removePhoneWork,
  type PhoneQueueSettings,
} from './phone-queue.ts';
import { delayAfterAttempt, maxAttempts, type RetryPolicy } from './policy.ts';
import { dismissOpenTasks } from './commands.ts';
import { UNFINISHED_STATUSES } from './state-machine.ts';
import { REFUSED_CONTENT_ERROR } from './status-display.ts';
import {
  operationPriority,
  transitionOperation,
  type OperationError,
  type OperationRow,
} from './transitions.ts';

export interface StepDependencies {
  /** The database; a phone step's claim may run in the API request's own transaction. */
  db: DbExecutor;
  adapters: AdapterLookup;
  logger: Logger;
  policy: RetryPolicy;
  /** Deadline for one adapter call; a send that misses it has an unknown result. */
  callTimeoutMs: number;
  /** How long an operation waiting behind an older one on its listing sleeps between checks. */
  blockedRecheckMs: number;
  /**
   * Whether this process can run automated steps (it is the browser runner). Elsewhere they are
   * handed over to the runner. Default false.
   */
  runsAutomation?: boolean;
  /** Called after a step was handed over to the browser runner, to make sure one is running. */
  onAutomationHandover?: () => void;
  /** How steps handed to the phone are rechecked and how long they may wait (phone-queue.ts). */
  phone?: PhoneQueueSettings;
  /** Called after a step was handed to the phone, so the host can ask the phone to run it. */
  onPhoneHandover?: () => void;
}

/**
 * Who runs a claimed step: the worker (which hands every automated step on), the browser
 * runner, or the phone (docs/features/phone-execution.md), which runs the automated steps of a
 * connection whose steps run on it.
 */
export type StepHost = 'worker' | 'runner' | 'phone';

/** What a claim found: a step to run, nothing to do now, or a step handed to another host. */
export type Claim =
  | { type: 'step'; step: ClaimedStep }
  | { type: 'none' }
  | { type: 'handed_over'; to: 'runner' | 'phone' };

type ListingRow = Selectable<MarketplaceListingTable>;
type FoundRemote = Extract<RemoteListingState, { found: true }>;

interface StepContext {
  /** The operation as the claim left it; the record phase requires it unchanged. */
  op: OperationRow;
  listing: ListingRow;
  adapter: MarketplaceAdapter;
  connection: ConnectionRef | null;
  desired: DesiredListingState;
  /** The part of `desired` a read-back can show (`readBackState`): what read-backs compare. */
  checked: DesiredListingState;
  /**
   * The id this step named the new listing with (`nameNewListing`), now the listing's pending
   * id; `null` when the step named none.
   */
  namedListingId: string | null;
  /** The listing content a create, revise, or relist publishes; `null` for other kinds. */
  content: ListingContent | null;
  /** How the operation runs under the connection; an `unsupported` one is never sent. */
  mode: OperationMode;
  /** Whether a read-back can decide the operation: only in `api` and `automation` mode. */
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

/** A claimed step, for a host that runs its calls itself (the phone). */
export type ClaimedStep = Step;

/**
 * A claimed step as data, so a host that runs it over several requests (the phone) can load
 * it again for each (`loadClaimedStep`): which step, and the operation exactly as the claim left
 * it, which every later load and the record phase require unchanged.
 */
export interface ClaimedStepRef {
  accountId: string;
  operationId: string;
  type: Step['type'];
  attempt: number;
  precheck: boolean;
  status: OperationStatus;
  attempts: number;
  namedListingId: string | null;
}

type Resolution =
  | {
      type: 'succeeded';
      proof: SuccessProof;
      /** The first targeted listing the read-backs found; `null` when every one is absent. */
      remote: FoundRemote | null;
      /** Targeted listing ids the marketplace says do not exist; the listing row retires them. */
      absentIds: string[];
    }
  /** Send again later, if attempts remain. */
  | { type: 'retry'; error: OperationError; retryAfterMs?: number }
  /**
   * Read the listing back later. With `unknownResult`, a send may have taken effect, so the
   * read-back happens even when no attempts remain.
   */
  | {
      type: 'verify';
      error: OperationError;
      unknownResult: boolean;
      /** The read must be repeated to confirm a match: it follows soon, not after the backoff. */
      soon?: boolean;
    }
  | { type: 'failed'; error: OperationError }
  | { type: 'user'; task: UserTaskSpec };

/** What a step's calls found, and the revisions they saw, for the record phase. */
export interface CalledStep {
  result: StepResult;
  seen: SeenRevisions;
}

interface StepResult {
  resolution: Resolution;
  /** A listing id the marketplace returned, kept even when the result is not yet verified. */
  externalListingId?: string;
  /** Nothing reached the marketplace listing: the send was refused, or never made. */
  nothingApplied?: true;
  detail: Record<string, unknown>;
}

/** Runs the next step of an operation. Throws only for database failures and bugs. */
export async function runOperationStep(
  deps: StepDependencies,
  payload: OperationJobPayload,
  signal: AbortSignal,
): Promise<void> {
  const claim = await claimOperationStep(
    deps,
    payload,
    deps.runsAutomation === true ? 'runner' : 'worker',
  );
  if (claim.type === 'handed_over') {
    if (claim.to === 'runner') deps.onAutomationHandover?.();
    else deps.onPhoneHandover?.();
    return;
  }
  if (claim.type === 'none') return;
  const called = await callOperationStep(deps, claim.step, signal);
  await recordOperationStep(deps, claim.step, called);
}

/** Claims the operation's next step for `host` (phase 1). */
export async function claimOperationStep(
  deps: StepDependencies,
  payload: OperationJobPayload,
  host: StepHost,
): Promise<Claim> {
  const step = await claimStep(deps, payload, host);
  if (step === null) return { type: 'none' };
  if (step === 'handed_over_to_runner') return { type: 'handed_over', to: 'runner' };
  if (step === 'handed_over_to_phone') return { type: 'handed_over', to: 'phone' };
  return { type: 'step', step };
}

/**
 * Runs a claimed step's marketplace calls (phase 2), with no transaction open. It is a pure
 * function of the step and of what the adapter's calls answer, so the phone's host runs it again
 * with every answer it has (each phone call is one more answer) and gets the same calls.
 */
export async function callOperationStep(
  deps: StepDependencies,
  step: ClaimedStep,
  signal: AbortSignal,
): Promise<CalledStep> {
  const seen = storedRevisions(step.ctx);
  const result =
    step.type === 'send'
      ? await performSend(deps, step, seen, signal)
      : await performCheck(deps, step, seen, signal);
  return { result, seen };
}

/**
 * Records a step's result (phase 3), if the operation is still exactly as the claim left it.
 * `onRecorded` runs in the recording transaction (the phone's host removes its work there).
 */
export async function recordOperationStep(
  deps: StepDependencies,
  step: ClaimedStep,
  called: CalledStep,
  onRecorded?: (trx: DbTransaction) => Promise<void>,
): Promise<void> {
  await recordResult(deps, step, called.result, called.seen, onRecorded);
}

/** The claimed step as data (`ClaimedStepRef`). */
export function claimedStepRef(step: ClaimedStep): ClaimedStepRef {
  return {
    accountId: step.ctx.op.account_id,
    operationId: step.ctx.op.id,
    type: step.type,
    attempt: step.attempt,
    precheck: step.type === 'send' && step.precheck,
    status: step.ctx.op.status,
    attempts: step.ctx.op.attempts,
    namedListingId: step.ctx.namedListingId,
  };
}

/**
 * Loads a claimed step again from its ref, without changing anything; `null` when the
 * operation is no longer as the claim left it (another host took it over, the user canceled
 * it) or can no longer be run, which ends the claim.
 */
export async function loadClaimedStep(
  deps: StepDependencies,
  ref: ClaimedStepRef,
): Promise<ClaimedStep | null> {
  return inTransaction(deps.db, async (trx) => {
    const op = await trx
      .selectFrom('marketplace_operation')
      .selectAll()
      .where('account_id', '=', ref.accountId)
      .where('id', '=', ref.operationId)
      .executeTakeFirst();
    if (op?.status !== ref.status || op.attempts !== ref.attempts) return null;
    const loaded = await loadStepBase(trx, deps, op);
    if (loaded.type !== 'ok') return null;
    const listing =
      ref.namedListingId === null
        ? loaded.base.listing
        : { ...loaded.base.listing, pending_external_listing_id: ref.namedListingId };
    const ctx: StepContext = {
      ...loaded.base,
      op,
      listing,
      namedListingId: ref.namedListingId,
      targets: listingTargets(listing, loaded.base.desired),
    };
    return ref.type === 'send'
      ? { type: 'send', ctx, precheck: ref.precheck, attempt: ref.attempt }
      : { type: 'check', ctx, attempt: ref.attempt };
  });
}

// Claim -----------------------------------------------------------------------------------

type Base = Omit<StepContext, 'op'>;

type LoadedBase =
  | {
      type: 'ok';
      base: Base;
      /** Where the connection's automated steps run, and the phone that runs them. */
      runsOn: ExecutionLocation;
    }
  | { type: 'no_adapter'; name: string }
  | { type: 'invalid'; name: string; reason: string };

/** Everything a step of `op` needs that the claim does not change. */
async function loadStepBase(
  trx: DbTransaction,
  deps: StepDependencies,
  op: OperationRow,
): Promise<LoadedBase> {
  const listing = await trx
    .selectFrom('marketplace_listing')
    .selectAll()
    .where('account_id', '=', op.account_id)
    .where('id', '=', op.listing_id)
    .executeTakeFirstOrThrow();
  const name = MARKETPLACE_NAMES[listing.marketplace];
  const adapter = deps.adapters(listing.marketplace);
  if (adapter === undefined) return { type: 'no_adapter', name };
  let desired: DesiredListingState;
  let content: ListingContent | null = null;
  try {
    desired = validateDesiredState(op.kind, op.desired);
    if (isContentKind(op.kind)) content = parseListingContent(op.content);
  } catch (error) {
    return {
      type: 'invalid',
      name,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const loaded = await loadConnection(trx, listing);
  const connection = loaded?.ref ?? null;
  const capabilities = adapter.capabilities(connection);
  const mode = operationMode(capabilities, op.kind);
  return {
    type: 'ok',
    runsOn: loaded?.runsOn ?? 'cloud',
    base: {
      listing,
      adapter,
      connection,
      desired,
      checked: readBackState(desired, capabilities),
      namedListingId: null,
      content,
      mode,
      canReadBack: mode === 'api' || mode === 'automation',
      freshness: capabilities.readFreshness,
      targets: listingTargets(listing, desired),
      name,
    },
  };
}

/**
 * The step to run, `null` when there is none, or the host it was handed to. A worker hands
 * every automated step on: to the browser runner, or to the phone when the connection's steps
 * run there. The runner and the phone each run the automated steps that are theirs and hand on
 * one whose connection moved to the other.
 */
async function claimStep(
  deps: StepDependencies,
  payload: OperationJobPayload,
  host: StepHost,
): Promise<Step | null | 'handed_over_to_runner' | 'handed_over_to_phone'> {
  return inTransaction(deps.db, async (trx) => {
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
        await removePhoneWork(trx, op);
        return null;
      case 'queued':
      case 'retrying':
      case 'running':
      case 'verifying':
        break;
      default:
        return assertNever(op.status, 'operation status');
    }

    const loaded = await loadStepBase(trx, deps, op);
    if (loaded.type !== 'ok') {
      await removePhoneWork(trx, op);
      if (loaded.type === 'no_adapter') {
        // Without an adapter nothing can be sent or read back. An operation that may already
        // have been sent fails as unconfirmed, so Retry knows to read it back first.
        const mayHaveBeenSent = op.status === 'running' || op.status === 'verifying';
        await transitionOperation(trx, op, {
          to: 'failed',
          error: mayHaveBeenSent
            ? cannotConfirm(loaded.name)
            : {
                code: 'marketplace_unavailable',
                message: `Listora can't connect to ${loaded.name} yet.`,
              },
        });
        return null;
      }
      await transitionOperation(
        trx,
        op,
        {
          to: 'failed',
          error: {
            code: 'invalid_operation',
            message: `This change can't be sent to ${loaded.name}.`,
          },
        },
        { reason: loaded.reason },
      );
      return null;
    }
    const { base, runsOn } = loaded;
    const { listing, name, mode, canReadBack } = base;

    // An automated step runs where its connection's steps run; everything else on the worker.
    const runsAt: 'runner' | 'phone' | null =
      mode === 'automation' ? (runsOn === 'phone' ? 'phone' : 'runner') : null;
    const handOverTo: 'runner' | 'phone' | null =
      runsAt !== null && runsAt !== host ? runsAt : null;
    if (runsAt !== 'phone' || host === 'phone') {
      // A step the phone no longer runs (its connection moved to the cloud) waits there no more.
      if (host !== 'phone') await removePhoneWork(trx, op);
    } else {
      const work = await phoneWorkOf(trx, op);
      if (work !== undefined && work.leaseExpiresAt !== null) {
        if (work.leaseExpiresAt.getTime() > Date.now()) {
          // The phone is running this step: look again once its lease would have run out.
          await scheduleOperationJob(trx, {
            accountId: op.account_id,
            operationId: op.id,
            listingId: op.listing_id,
            priority: operationPriority(op),
            runAt: new Date(work.leaseExpiresAt.getTime() + 1_000),
          });
          return 'handed_over_to_phone';
        }
        // The phone stopped in the middle of the step: it is recovered like any other.
        await removePhoneWork(trx, op);
        log.warn('a phone run of the step stopped before it finished');
      }
    }

    const handOver = async (): Promise<'handed_over_to_runner' | 'handed_over_to_phone' | null> => {
      if (handOverTo === 'runner') {
        await removePhoneWork(trx, op);
        await scheduleOperationJob(trx, {
          accountId: op.account_id,
          operationId: op.id,
          listingId: op.listing_id,
          priority: operationPriority(op),
          runAt: null,
          task: AUTOMATION_OPERATION_TASK,
        });
        log.debug({ status: op.status }, 'automated step handed over to the browser runner');
        return 'handed_over_to_runner';
      }
      // To the phone. A connection reaches the phone only through a listing that has one.
      const settings = deps.phone ?? DEFAULT_PHONE_QUEUE;
      const connectionId = listing.connection_id;
      if (connectionId === null) throw new Error('an automated step has a connection');
      const waitingSince = await queueOperationForPhone(trx, op, {
        connectionId,
        marketplace: listing.marketplace,
        priority: operationPriority(op),
      });
      const waited = Date.now() - waitingSince.getTime();
      if (waited >= settings.maxWaitMs) {
        await removePhoneWork(trx, op);
        await transitionOperation(trx, op, {
          to: 'failed',
          error:
            op.status === 'verifying'
              ? cannotConfirm(name)
              : {
                  code: PHONE_UNAVAILABLE_ERROR,
                  message: `Your iPhone hasn't run this on ${name} for ${String(Math.round(settings.maxWaitMs / 3_600_000))} hours. Open Listora on your iPhone, then tap Retry.`,
                },
        });
        log.warn({ waitedMs: waited }, 'an operation waited for the phone too long');
        return null;
      }
      await scheduleOperationJob(trx, {
        accountId: op.account_id,
        operationId: op.id,
        listingId: op.listing_id,
        priority: operationPriority(op),
        runAt: new Date(Date.now() + Math.min(settings.recheckMs, settings.maxWaitMs - waited)),
      });
      log.debug({ status: op.status }, 'automated step handed to the phone');
      return 'handed_over_to_phone';
    };
    const max = maxAttempts(deps.policy);

    if (op.status === 'running') {
      // The step that set `running` never recorded its result: its worker stopped mid-step.
      const interrupted = {
        code: 'interrupted',
        message: `Listora was interrupted and is checking the listing on ${name}.`,
      };
      // Only a step that was assisted throughout has no remote effect (it only creates a user
      // task, atomically with its result); one that went through the API may have reached the
      // marketplace, even when the listing is served assisted now.
      const purelyAssisted = mode === 'assisted' && !(await wasSentThroughApi(trx, op));
      if (canReadBack) {
        await transitionOperation(
          trx,
          op,
          { to: 'verifying', delayMs: 0, error: interrupted },
          { recovered: true },
        );
      } else if (purelyAssisted && op.attempts < max) {
        await transitionOperation(
          trx,
          op,
          { to: 'retrying', delayMs: 0, error: interrupted },
          { recovered: true },
        );
      } else {
        await transitionOperation(trx, op, {
          to: 'failed',
          // A step that may have reached the marketplace and can't be read back is unconfirmed.
          error: purelyAssisted
            ? { code: 'interrupted', message: 'Listora was interrupted. Tap Retry.' }
            : cannotConfirm(name),
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
      if (handOverTo !== null) return handOver();
      return { type: 'check', ctx: { op, ...base }, attempt: op.attempts + 1 };
    }

    // queued or retrying: a new attempt, once every older operation on the listing is done. A
    // delist does not wait for older operations that wait for the user; it supersedes them.
    if (isDelistKind(op.kind) && mode !== 'unsupported' && op.attempts < max) {
      await supersedeUserSteps(trx, op, log);
    }
    if (await hasOlderUnfinishedOperation(trx, op)) {
      await removePhoneWork(trx, op);
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
    if (mode === 'unsupported') {
      await transitionOperation(trx, op, {
        to: 'failed',
        error: {
          code: op.kind === 'verify' ? 'cannot_verify' : 'not_supported',
          message: unsupportedMessage(op.kind, listing.marketplace),
        },
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

    if (handOverTo !== null) return handOver();

    const named = await nameNewListing(trx, op, base);
    if (named.type === 'taken') {
      await transitionOperation(trx, op, { to: 'failed', error: linkedElsewhere(name) });
      return null;
    }
    const naming =
      named.type === 'named'
        ? {
            listing: named.listing,
            namedListingId: named.id,
            targets: listingTargets(named.listing, base.desired),
          }
        : {};
    const precheck = op.kind !== 'verify' && canReadBack && (await wasSentBefore(trx, op));
    const running = await transitionOperation(
      trx,
      op,
      { to: 'running' },
      {
        step: op.kind === 'verify' ? 'check' : 'send',
        precheck,
        mode,
        ...(host === 'worker' ? {} : { host }),
        ...(named.type === 'named' ? { [NAMED_LISTING_KEY]: named.id } : {}),
      },
    );
    const ctx = { op: running, ...base, ...naming };
    return op.kind === 'verify'
      ? { type: 'check', ctx, attempt: running.attempts }
      : { type: 'send', ctx, precheck, attempt: running.attempts };
  });
}

async function loadConnection(
  trx: DbTransaction,
  listing: ListingRow,
): Promise<{ ref: ConnectionRef; runsOn: ExecutionLocation } | null> {
  if (listing.connection_id === null) return null;
  const connection = await trx
    .selectFrom('marketplace_connection')
    .select(['id', 'mode', 'status', 'runs_on'])
    .where('account_id', '=', listing.account_id)
    .where('id', '=', listing.connection_id)
    .executeTakeFirst();
  if (connection === undefined) return null;
  return {
    ref: { id: connection.id, mode: connection.mode, status: connection.status },
    runsOn: connection.runs_on,
  };
}

/**
 * The `running` event detail key that records the id a step named a new listing with. Events
 * with it are kept for good (the retention job skips them), so a name is never given twice.
 */
export const NAMED_LISTING_KEY = 'namedListingId';

type Naming =
  | { type: 'none' }
  | { type: 'named'; id: string; listing: ListingRow }
  /** Another of the account's listings already has the id. */
  | { type: 'taken' };

/**
 * Names the new marketplace listing of a create or relist, for an adapter whose marketplace
 * lets Listora name listings (`newListingId`: Depop's SKUs), before anything is sent. The id
 * becomes the listing's pending id in the claim's transaction, so every later step, a
 * read-back after a lost answer included, reaches it. The operation keeps the id it was given
 * first (its `running` events record it), so every attempt and every Retry sends the same one.
 * A listing that already has a pending id keeps it, since an earlier create or relist may have
 * made that listing, and naming another could leave two live. A create names only a listing
 * that has no marketplace listing yet; a relist one that has.
 */
async function nameNewListing(
  trx: DbTransaction,
  op: OperationRow,
  ctx: Pick<StepContext, 'listing' | 'adapter' | 'connection' | 'content' | 'mode'>,
): Promise<Naming> {
  const { listing, adapter, content } = ctx;
  if (ctx.mode !== 'api' || content === null || adapter.newListingId === undefined) {
    return { type: 'none' };
  }
  if (op.kind !== 'create' && op.kind !== 'relist') return { type: 'none' };
  if (listing.pending_external_listing_id !== null) return { type: 'none' };
  if ((op.kind === 'create') !== (listing.external_listing_id === null)) return { type: 'none' };
  const id =
    (await namedBefore(trx, op)) ??
    adapter.newListingId(content.item, await usedListingIds(trx, listing), ctx.connection);
  if (id === null || id === listing.external_listing_id) return { type: 'none' };
  if (await externalIdTaken(trx, listing, id)) return { type: 'taken' };
  await trx
    .updateTable('marketplace_listing')
    .set({ pending_external_listing_id: id, pending_remote_revision: null })
    .where('account_id', '=', listing.account_id)
    .where('id', '=', listing.id)
    .execute();
  return {
    type: 'named',
    id,
    listing: { ...listing, pending_external_listing_id: id, pending_remote_revision: null },
  };
}

/** The id an earlier step of this operation named its new listing with, if any. */
async function namedBefore(trx: DbTransaction, op: OperationRow): Promise<string | null> {
  const event = await trx
    .selectFrom('operation_event')
    .select(sql<string>`detail->>${NAMED_LISTING_KEY}`.as('named'))
    .where('account_id', '=', op.account_id)
    .where('operation_id', '=', op.id)
    .where('to_status', '=', 'running')
    .where(sql<boolean>`detail ? ${NAMED_LISTING_KEY}`)
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  return event?.named ?? null;
}

/**
 * Every id the listing's item has had on the listing's marketplace: the ids of its listings
 * there, and every id an operation on them named, so a name is never given twice.
 */
async function usedListingIds(trx: DbTransaction, listing: ListingRow): Promise<string[]> {
  const listings = await trx
    .selectFrom('marketplace_listing')
    .select(['id', 'external_listing_id', 'pending_external_listing_id'])
    .where('account_id', '=', listing.account_id)
    .where('item_id', '=', listing.item_id)
    .where('marketplace', '=', listing.marketplace)
    .execute();
  const named = await trx
    .selectFrom('operation_event as e')
    .innerJoin('marketplace_operation as o', (join) =>
      join.onRef('o.account_id', '=', 'e.account_id').onRef('o.id', '=', 'e.operation_id'),
    )
    .select(sql<string>`e.detail->>${NAMED_LISTING_KEY}`.as('named'))
    .where('e.account_id', '=', listing.account_id)
    .where(
      'o.listing_id',
      'in',
      listings.map((row) => row.id),
    )
    .where(sql<boolean>`e.detail ? ${NAMED_LISTING_KEY}`)
    .execute();
  const ids = [
    ...listings.flatMap((row) => [row.external_listing_id, row.pending_external_listing_id]),
    ...named.map((row) => row.named),
  ];
  return [...new Set(ids.filter((id): id is string => id !== null))];
}

/**
 * The marketplace listings an operation targets: the newest known id, where a pending one (not
 * yet confirmed by a read-back) wins over the verified one. An end also targets the verified id
 * when a pending one exists, since either may still be live.
 */
function listingTargets(listing: ListingRow, desired: DesiredListingState): Targets {
  // The listing's URL is the verified listing's page; a pending id has none known yet.
  const ref = (externalListingId: string | null, externalUrl: string | null): ListingRef => ({
    listingId: listing.id,
    externalListingId,
    externalSku: listing.external_sku,
    externalUrl,
  });
  const pending = listing.pending_external_listing_id;
  const verified = listing.external_listing_id;
  const verifiedRef = ref(verified, listing.external_url);
  if (pending === null) return [verifiedRef];
  if (desired.status === 'ended' && verified !== null) return [ref(pending, null), verifiedRef];
  return [ref(pending, null)];
}

/** An end or mark-sold: the delist that must not wait behind an unanswered user task. */
function isDelistKind(kind: OperationRow['kind']): boolean {
  return kind === 'end' || kind === 'mark_sold';
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

/**
 * Closes the older operations on a delist's listing that wait for the user, and the ones queued
 * or waiting to retry behind them that never went through the API (they have had no remote
 * effect, and the delist makes them moot). Each is canceled as superseded by the delist, in its
 * history, and its open tasks are dismissed, never marked done. Without an older operation that
 * waits for the user, nothing is closed and the listing's order stands. The delist creates its
 * own task when the listing is assisted.
 */
async function supersedeUserSteps(
  trx: DbTransaction,
  delist: OperationRow,
  log: Logger,
): Promise<void> {
  const older = await trx
    .selectFrom('marketplace_operation')
    .selectAll()
    .where('account_id', '=', delist.account_id)
    .where('listing_id', '=', delist.listing_id)
    .where('status', 'in', ['needs_user_action', 'queued', 'retrying'])
    .where(createdBefore(delist))
    .orderBy('created_at')
    .orderBy('id')
    .forUpdate()
    .execute();
  const firstWaiting = older.findIndex((candidate) => candidate.status === 'needs_user_action');
  if (firstWaiting === -1) return;
  const superseded: string[] = [];
  for (const candidate of older.slice(firstWaiting)) {
    if (candidate.status !== 'needs_user_action' && (await wasSentThroughApi(trx, candidate))) {
      continue;
    }
    await transitionOperation(
      trx,
      candidate,
      { to: 'canceled' },
      { action: 'supersede', reason: 'superseded by delist', supersededBy: delist.id },
    );
    await removeOperationJob(trx, candidate.id);
    await dismissOpenTasks(trx, candidate);
    superseded.push(candidate.id);
  }
  log.info({ superseded }, 'a delist superseded operations waiting for the user');
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
    if (comparison.matches) {
      return {
        resolution: readBackSuccess(comparison.proof, read.remote, ref),
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
  const prepared = preparePayload(deps, ctx);
  if (!prepared.ok) {
    return {
      resolution: { type: 'failed', error: prepared.error },
      nothingApplied: true,
      detail: { step: 'send', sent: false, ...prepared.detail },
    };
  }
  const request: OperationRequest = {
    operationId: ctx.op.id,
    kind,
    idempotencyKey: ctx.op.idempotency_key,
    attempt: step.attempt,
    desired: ctx.desired,
    listing: ref,
    payload: prepared.payload,
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
      if (comparison.matches) {
        return {
          resolution: readBackSuccess(comparison.proof, read.remote, target),
          detail,
          ...withId,
        };
      }
      return {
        resolution: undecidedRead(ctx, comparison, true) ?? {
          type: 'verify',
          error: notShown(ctx.name, comparison.fields),
          unknownResult: true,
        },
        detail: { ...detail, readBack: comparison },
        ...withId,
      };
    }
    case 'rejected': {
      const error = {
        code: outcome.code,
        message:
          outcome.fixHint === undefined ? outcome.message : `${outcome.message} ${outcome.fixHint}`,
      };
      // An end or mark-sold the marketplace refused (for a listing it no longer has, say) may
      // have nothing left to do; only a read-back can tell.
      if (ctx.canReadBack && (ctx.desired.status === 'ended' || ctx.desired.status === 'sold')) {
        const read = await readOnce(deps, ctx, ref, signal);
        if (read.ok) {
          const comparison = compareReadBack(ctx, read.remote, seen, false);
          if (comparison.matches) {
            return {
              resolution: readBackSuccess(comparison.proof, read.remote, ref),
              detail: { ...detail, readBack: { matches: true } },
            };
          }
          const undecided = undecidedRead(ctx, comparison, false);
          if (undecided !== undefined) {
            return { resolution: undecided, detail: { ...detail, readBack: comparison } };
          }
        }
      }
      // A refusal applied nothing (an end or mark-sold the read-back above could not settle
      // keeps its targets, since they may be live).
      return { resolution: { type: 'failed', error }, nothingApplied: true, detail };
    }
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
      // An assisted operation waits for the user, and so does an automated one whose session
      // met a check automation must not pass; an api one must be read back.
      if (ctx.mode !== 'assisted' && ctx.mode !== 'automation') {
        return {
          resolution: { type: 'failed', error: cannotConfirm(ctx.name) },
          detail: { ...detail, reason: 'a user task for an api operation' },
        };
      }
      return { resolution: { type: 'user', task: outcome.task }, detail };
    default:
      return assertNever(outcome, 'adapter outcome');
  }
}

type PreparedPayload =
  | { ok: true; payload: ListingPayload | null }
  | { ok: false; error: OperationError; detail: Record<string, unknown> };

/**
 * Builds the payload of a create, revise, or relist from its listing content with the adapter's
 * pure builder, under the connection the step runs with, and refuses it when the adapter's
 * validation finds issues. Other kinds carry no payload.
 */
function preparePayload(deps: StepDependencies, ctx: StepContext): PreparedPayload {
  if (ctx.content === null) return { ok: true, payload: null };
  const { item, variant } = ctx.content;
  try {
    const payload = ctx.adapter.buildPayload(item, variant, ctx.connection);
    const issues = ctx.adapter.validate(payload, ctx.connection);
    const [first] = issues;
    if (first === undefined) return { ok: true, payload };
    return {
      ok: false,
      error: {
        code: REFUSED_CONTENT_ERROR,
        message: `${first.message} Fix it, then try again.`,
      },
      detail: { issues: issues.map(({ field, code, message }) => ({ field, code, message })) },
    };
  } catch (error) {
    // The builders are pure functions of the content; one that throws is a bug.
    deps.logger.error({ err: error, operationId: ctx.op.id }, 'building the payload failed');
    return {
      ok: false,
      error: { code: 'invalid_operation', message: `This change can't be sent to ${ctx.name}.` },
      detail: { reason: 'the payload builder threw' },
    };
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
  if (comparison.matches) {
    return {
      resolution: readBackSuccess(comparison.proof, read.remote, ref),
      detail: { step: 'check' },
    };
  }
  const detail = { step: 'check', readBack: comparison };
  const undecided = undecidedRead(ctx, comparison, false);
  if (undecided !== undefined) return { resolution: undecided, detail };
  const { fields } = comparison;
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

  const successes: Extract<Resolution, { type: 'succeeded' }>[] = [];
  for (const resolution of resolutions) {
    if (resolution.type !== 'succeeded') throw new Error('every target should have succeeded');
    successes.push(resolution);
  }
  const [first, ...rest] = successes.map((success) => success.proof);
  if (first === undefined) throw new Error('a step has at least one target');
  return {
    resolution: {
      type: 'succeeded',
      proof: confirmEveryReadBack([first, ...rest]),
      remote: successes.find((success) => success.remote !== null)?.remote ?? null,
      absentIds: successes.flatMap((success) => success.absentIds),
    },
    detail,
    ...withId,
  };
}

/** A target's success: the listing read back, or the id the marketplace says does not exist. */
function readBackSuccess(
  proof: SuccessProof,
  remote: RemoteListingState,
  ref: ListingRef,
): Extract<Resolution, { type: 'succeeded' }> {
  if (remote.found) return { type: 'succeeded', proof, remote, absentIds: [] };
  return {
    type: 'succeeded',
    proof,
    remote: null,
    absentIds: ref.externalListingId === null ? [] : [ref.externalListingId],
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
  const comparison = confirmByReadBack(ctx.checked, remote, freshness);
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
      return { type: 'verify', error: confirmingAgain(ctx.name), unknownResult, soon: true };
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
      ctx.adapter.readListing(ref, {
        signal: callSignal,
        connection: ctx.connection,
        operationId: ctx.op.id,
      }),
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
      ctx.adapter.execute(request, {
        signal: callSignal,
        connection: ctx.connection,
        operationId: ctx.op.id,
      }),
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
  onRecorded?: (trx: DbTransaction) => Promise<void>,
): Promise<void> {
  const { ctx } = step;
  const log = deps.logger.child({ accountId: ctx.op.account_id, operationId: ctx.op.id });
  await inTransaction(deps.db, async (trx) => {
    await recordIn(trx);
    // Whether or not the result counted, the step is over for its host.
    await onRecorded?.(trx);
  });

  async function recordIn(trx: DbTransaction): Promise<void> {
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

    // An id this step named a new listing with, whose send was refused or never made, names
    // nothing on the marketplace: the listing forgets it, so it can't keep a delist waiting for
    // a listing that was never made. The operation keeps it for its Retry.
    let pendingId = ctx.listing.pending_external_listing_id;
    if (ctx.namedListingId !== null && result.nothingApplied === true) {
      await trx
        .updateTable('marketplace_listing')
        .set({ pending_external_listing_id: null, pending_remote_revision: null })
        .where('account_id', '=', op.account_id)
        .where('id', '=', op.listing_id)
        .where('pending_external_listing_id', '=', ctx.namedListingId)
        .execute();
      pendingId = null;
    }

    // A listing id the marketplace returned becomes the listing's pending id at once, so every
    // later step and operation on the listing reaches it, verified or not.
    const learned = result.externalListingId;
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
  }
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
      const { remote, absentIds } = resolution;
      if (
        remote !== null &&
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
      await applyVerifiedListing(trx, ctx.listing, ctx.desired, remote, absentIds);
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
      // A send whose result is unknown, or a match that must be read again, is checked soon
      // (never later than the backoff): the seller is waiting to see it listed, and nothing is
      // sent again meanwhile.
      const soon = resolution.soon === true || (resolution.unknownResult && step.type === 'send');
      const backoffMs = delayAfterAttempt(deps.policy, attempts);
      const delayMs = soon ? Math.min(CHECK_SOON_MS, backoffMs) : backoffMs;
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
      const waiting = await transitionOperation(trx, op, { to: 'needs_user_action' }, detail);
      if (!(await delistSaleStands(trx, op))) {
        // The sale was canceled or returned while this step ran, after the lifecycle stopped the
        // run's waiting delists (`cancelUnsentDelists` skips a running one): the seller may keep
        // the item listed, so no task asks them to delist it.
        await transitionOperation(
          trx,
          waiting,
          { to: 'canceled' },
          { action: 'cancel', reason: 'the sale no longer stands' },
        );
        return 'canceled';
      }
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
 * Whether the sale an auto-delist serves still stands (true for every other operation). The sale
 * is read under a share lock, so a cancel or return committing meanwhile is either seen here or
 * waits for this step, after which it stops the delist itself (the sale lifecycle locks the sale
 * before it cancels the run's waiting delists).
 */
async function delistSaleStands(trx: DbTransaction, op: OperationRow): Promise<boolean> {
  if (op.delist_run_id === null) return true;
  const run = await trx
    .selectFrom('delist_run')
    .select('sale_id')
    .where('account_id', '=', op.account_id)
    .where('id', '=', op.delist_run_id)
    .executeTakeFirst();
  if (run === undefined) return true;
  const sale = await trx
    .selectFrom('sale')
    .select('status')
    .where('account_id', '=', op.account_id)
    .where('id', '=', run.sale_id)
    .forShare()
    .executeTakeFirst();
  return sale === undefined || (sale.status !== 'canceled' && sale.status !== 'returned');
}

/**
 * Records what the marketplace confirmed on the listing row. A confirmed pending id becomes the
 * verified one and keeps its revisions; an id new to the row starts its own. Ids the
 * marketplace says do not exist are retired.
 */
async function applyVerifiedListing(
  trx: DbTransaction,
  listing: ListingRow,
  desired: DesiredListingState,
  remote: FoundRemote | null,
  absentIds: readonly string[],
): Promise<void> {
  const status = remote?.status ?? desired.status;
  if (status === undefined) throw new Error('an absent listing confirms only a status change');
  const absent = sql<string[]>`${[...absentIds]}::text[]`;
  const pendingSettled =
    remote === null
      ? sql<boolean>`pending_external_listing_id = any(${absent})`
      : sql<boolean>`(pending_external_listing_id = ${remote.externalListingId}
          or pending_external_listing_id = any(${absent}))`;
  const verified =
    remote === null
      ? {
          external_listing_id: sql<string | null>`
            case when external_listing_id = any(${absent}) then null else external_listing_id end`,
          external_url: sql<string | null>`
            case when external_listing_id = any(${absent}) then null else external_url end`,
          remote_revision: sql<number | null>`
            case when external_listing_id = any(${absent}) then null else remote_revision end`,
        }
      : {
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
        };
  await trx
    .updateTable('marketplace_listing')
    .set({
      status,
      ...verified,
      pending_external_listing_id: sql<string | null>`
        case when ${pendingSettled} then null else pending_external_listing_id end`,
      pending_remote_revision: sql<number | null>`
        case when ${pendingSettled} then null else pending_remote_revision end`,
      last_verified_at: sql<Date>`now()`,
      ...(status === 'active'
        ? { listed_at: sql<Date>`coalesce(listed_at, now())`, ended_at: null }
        : { ended_at: sql<Date>`coalesce(ended_at, now())` }),
    })
    .where('account_id', '=', listing.account_id)
    .where('id', '=', listing.id)
    .execute();
  await syncItemListedStatus(trx, listing.account_id, listing.item_id);
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

/** How soon a check follows a send with an unknown result, or a match that must be repeated. */
export const CHECK_SOON_MS = 15_000;

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
