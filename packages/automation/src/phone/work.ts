/**
 * Phone runs (docs/features/phone-execution.md): the server's half of running automated work
 * on the seller's iPhone. Work handed to the phone waits in `phone_work`: an operation step the
 * engine handed over (`@listora/operations`, phone-queue.ts), a session check, a sale check, or
 * a page of a listing import (imports/read.ts).
 * The app, signed in on the device that runs the connection, claims one (`claimPhoneRun`), runs
 * the script call the server gives it, and answers (`answerPhoneCall`), until the work is done.
 *
 * The server runs the work itself, as the worker and the browser runner do (the executor's
 * phases, the automation adapters, the checks' own code), with sessions answered from the
 * phone's answers (transcript.ts). After each answer it runs the work again from its start: the
 * first call without an answer is the phone's next call, and work whose calls are all answered
 * records its result there and then. So the phone never decides anything: it runs scripts, and
 * every rule of the engine (read-back before success, freshness, retries, the fallback to the
 * user) is the server's, exactly as for the runner.
 *
 * - **One run per connection at a time**, like the runner's per-seller lock, and per-seller rate
 *   limits and the pause between sessions, counted in `automation_run` with the runner's runs.
 * - **A lease** (`leaseMs`): a phone that stops mid-run (the app killed, the phone offline) lets
 *   its claim lapse, or gives it up when it next asks for work. The operation's job finds the lapsed run and recovers the step as any
 *   interrupted step (a read-back decides); a check's run waits again.
 * - **A check the seller won't pass** (an answer that stopped at a CAPTCHA, a bot check, a login
 *   page the seller declined) discards the stored session and asks for a relink, as on the
 *   runner. A check the seller completes, or will complete later, never reaches the server as a
 *   check (runtime.ts).
 */
import { sql, type Selectable } from 'kysely';

import {
  inTransaction,
  jsonb,
  lockConnections,
  type Db,
  type DbExecutor,
  type DbTransaction,
  type JsonArray,
  type JsonObject,
  type Marketplace,
  type PhoneWorkPurpose,
  type PhoneWorkTable,
  type SaleCheckReason,
} from '@listora/db';
import type { SessionVault } from '@listora/connections';
import {
  isFeatureOn,
  loadFeatureGate,
  MARKETPLACE_NAMES,
  type AdapterLookup,
  type ConnectionRef,
  type Health,
  type ListingsPage,
  type MarketplaceAdapter,
  type MarketplaceFeature,
  type RemoteOffer,
  type RemoteOrder,
  type RemoteOrderLabel,
} from '@listora/marketplaces';
import {
  callOperationStep,
  claimedStepRef,
  claimOperationStep,
  loadClaimedStep,
  recordOperationStep,
  type ClaimedStepRef,
  nextPhoneOperationDue,
  runWaitingPhoneOperationsNow,
  type PhoneQueueSettings,
  type RetryPolicy,
  type StepDependencies,
} from '@listora/operations';
import {
  ordersToRead,
  recordLabelReads,
  type LabelReadResult,
  type LabelReadTarget,
} from '@listora/pack-check';
import { changeSale, SaleStateError } from '@listora/sales';
import { assertNever, createLogger, type Logger } from '@listora/shared';

import { AutomationReadError } from '../adapter/automation-adapter.ts';

import type { AutomationSessions, SessionRequest } from '../adapter/sessions.ts';
import { rateLimitWait, runOutcome, runSteps } from '../adapter/runner-sessions.ts';
import {
  isAutomatedMarketplace,
  standInProfile,
  type AutomatedMarketplace,
  type AutomationProfile,
} from '../profiles.ts';
import { challengeMessage } from '../safety/challenges.ts';
import type { PageEvidence } from '../safety/evidence.ts';
import { Pacing } from '../safety/pacing.ts';
import {
  prepareSaleCheck,
  recordSaleCheckFailure,
  recordSaleCheckOrders,
  startSaleCheckRun,
  type StartedSaleCheck,
} from '../sale-checks/job.ts';
import type { SaleCheckSettings } from '../settings.ts';
import { prepareSessionCheck, recordSessionCheck } from '../session-checks/job.ts';
import { prepareImportPage, recordImportPage, recordImportPageFailure } from '../imports/read.ts';
import { isWriteCall } from '../adapter/script-call.ts';
import {
  prepareOfferAnswer,
  recordOfferAnswer,
  refuseOfferAnswer,
  runOfferAnswer,
} from '../offers/answer.ts';
import { recordOfferCheckFailure, recordOffers, startOfferCheck } from '../offers/record.ts';
import { queueSessionCheckForPhone } from '../session-checks/schedule.ts';
import { readPhoneAnswer, readPhoneEvidence } from './answers.ts';
import type { PhoneWorkSignals } from './signals.ts';
import { PHONE_RUNTIME_VERSION, type PhoneCallInput } from './runtime.ts';
import {
  callKey,
  TranscriptSessions,
  type PendingCall,
  type TranscriptEntry,
} from './transcript.ts';

export interface PhoneWorkDependencies {
  db: Db;
  /**
   * The marketplace adapters over `sessions`, as the worker builds them with its automation
   * adapters over these sessions, and those automation adapters alone (session checks use
   * them).
   */
  adapters: (sessions: AutomationSessions) => {
    lookup: AdapterLookup;
    automation: Partial<Record<AutomatedMarketplace, MarketplaceAdapter>>;
  };
  /** Each automated marketplace's configured profile: its site, pacing, and limits. */
  profiles: Readonly<Record<AutomatedMarketplace, AutomationProfile>>;
  /** Discards a session the marketplace rejected, as the runner does; none without a vault. */
  vault?: Pick<SessionVault, 'markNeedsRelink'>;
  policy: RetryPolicy;
  saleChecks: SaleCheckSettings;
  logger: Logger;
  /** One script step's time on the phone. */
  stepTimeoutMs: number;
  /** One call's deadline on the phone, not counting a check the seller completes. */
  callTimeoutMs: number;
  /** How long an operation waiting behind an older one sleeps between checks. */
  blockedRecheckMs: number;
  phone?: PhoneQueueSettings;
  /** How long a claim holds without word from the phone (default 10 minutes). */
  leaseMs?: number;
  /** Word that work may be ready, which ends the open app's wait for it (signals.ts). */
  signals?: PhoneWorkSignals;
}

/** A phone run, as the app sees it. */
export interface PhoneRunState {
  id: string;
  purpose: PhoneWorkPurpose;
  marketplace: Marketplace;
  operationId: string | null;
  /** The call the phone runs next; `null` once the run is over. */
  call: { index: number; input: PhoneCallInput } | null;
}

/** The device's runtime can't run this server's calls: the app needs an update. */
export class PhoneRuntimeMismatchError extends Error {
  constructor() {
    super('This version of Listora on your iPhone needs an update to run marketplace changes.');
    this.name = 'PhoneRuntimeMismatchError';
  }
}

/** The run is over, or not this device's (a lapsed claim, another phone, a finished run). */
export class PhoneRunGoneError extends Error {
  constructor() {
    super('This phone run is over.');
    this.name = 'PhoneRunGoneError';
  }
}

/** An answer for a call the server did not ask, or a different answer for one it already has. */
export class PhoneCallConflictError extends Error {
  constructor() {
    super('That answer is for a call this run is not waiting for.');
    this.name = 'PhoneCallConflictError';
  }
}

const DEFAULT_LEASE_MS = 10 * 60_000;
/**
 * The runtime versions the server hands work to. Version 2 (an app installed before offers) runs
 * every call but the offers' (docs/features/offers.md), which wait for its update; the app also
 * takes the server's own runtime between runs (`getPhoneRuntime`), which speaks the newest.
 */
export const SUPPORTED_PHONE_RUNTIME_VERSIONS: readonly number[] = [2, PHONE_RUNTIME_VERSION];
const OFFERS_PHONE_RUNTIME_VERSION = 3;
/** The longest a phone that runs marketplaces waits between looks while the app is open. */
export const PHONE_IDLE_CLAIM_SECONDS = 5;
/** About how long the engine takes to hand a due change to the phone. */
const HANDOVER_SECONDS = 1;
/** A change due this long ago that still isn't the phone's waits for its own job instead. */
const STALE_HANDOVER_MS = 60_000;
/** How often a phone that runs no marketplace looks (linking one runs its work at once). */
export const PHONE_UNUSED_CLAIM_SECONDS = 300;
/** Candidates one claim looks at before it says there is nothing to run. */
const MAX_CLAIM_CANDIDATES = 20;
const SILENT = createLogger({ service: 'phone-replay', level: 'silent' });

type WorkRow = Selectable<PhoneWorkTable>;

/** What the claim decided, kept on the row for every later run of the work. */
type StepState =
  | { kind: 'operation'; ref: ClaimedStepRef }
  | { kind: 'session_check'; checkId: string; attempt: number }
  | {
      kind: 'listing_import';
      importId: string;
      /** The page the claim read: an import page recorded meanwhile makes the run diverge. */
      cursor: string | null;
    }
  | {
      kind: 'sale_check';
      /** A read of the sold history (`sale_history` work) rather than a sale check. */
      history?: boolean;
      /** The check's record (`sale_check_run`); absent for a claim made before records. */
      runId?: string;
      reason?: SaleCheckReason;
      since: string | null;
      checkedThrough: string | null;
    }
  | { kind: 'label_read'; orders: LabelReadTarget[] }
  | { kind: 'offer_check' }
  | {
      kind: 'offer_response';
      responseId: string;
      /** Whether an earlier run may have sent the answer, as the claim found it: then it only reads. */
      sent: boolean;
    };

/** The call the phone runs now. */
interface PendingState {
  index: number;
  key: string;
  runId: string;
  input: PhoneCallInput;
}

/** The device asking for work, and what it says about itself. */
export interface ClaimingDevice {
  accountId: string;
  deviceId: string;
  runtimeVersion: number;
  /**
   * The runs the app is still running, one per marketplace (it runs marketplaces side by side);
   * every other run the device holds stopped. Absent: it runs none.
   */
  running?: readonly string[];
  /**
   * The seller has the app open: the device's changes waiting out a backoff run now
   * (`runWaitingPhoneOperationsNow`), and it is told to look again sooner.
   */
  appOpen?: boolean;
}

/**
 * Claims the device's next due work and returns its first call, or `null` when nothing waits
 * for it. Work on a connection that has a run under way waits, so a device that runs several
 * marketplaces side by side gets one run per marketplace. Runs in `executor`, the request's
 * transaction.
 */
export async function claimPhoneRun(
  deps: PhoneWorkDependencies,
  executor: DbExecutor,
  device: ClaimingDevice,
): Promise<PhoneRunState | null> {
  if (!SUPPORTED_PHONE_RUNTIME_VERSIONS.includes(device.runtimeVersion)) {
    throw new PhoneRuntimeMismatchError();
  }
  return inTransaction(executor, async (trx) => {
    await lockDeviceConnections(trx, device);
    await releaseStoppedRuns(trx, device);
    if (device.appOpen === true) await runWaitingPhoneOperationsNow(trx, device);
    for (let looked = 0; looked < MAX_CLAIM_CANDIDATES; looked += 1) {
      const work = await nextWork(trx, device);
      if (work === undefined) return null;
      const claimed = await claim(deps, trx, work);
      if (claimed !== null) return advance(deps, trx, claimed);
    }
    return null;
  });
}

/**
 * How long a phone with nothing to run waits before it asks again while the app is open
 * (docs/features/phone-execution.md, "When the phone runs"): until its next work is due (a
 * check tried again after a failed attempt, a change the engine is about to hand over, or one
 * the open app runs without its backoff), and never longer than `PHONE_IDLE_CLAIM_SECONDS`
 * while marketplaces run on it, so work queued meanwhile (a sale check, a delist after a sale)
 * starts within seconds without a push; a phone that runs none asks rarely.
 */
export async function nextPhoneClaimSeconds(
  executor: DbExecutor,
  device: { accountId: string; deviceId: string; appOpen?: boolean },
): Promise<number> {
  const due = await phoneWorkDue(executor, device);
  if (due.connections === 0) return PHONE_UNUSED_CLAIM_SECONDS;
  if (due.inMs === null) return PHONE_IDLE_CLAIM_SECONDS;
  return Math.min(PHONE_IDLE_CLAIM_SECONDS, Math.max(1, Math.ceil(due.inMs / 1000)));
}

/**
 * How many connections the device runs, and how long until its next work is claimable (`inMs`,
 * at most 0 when some is now): work handed to the phone once it is due and no run holds it or
 * another work of its connection (a marketplace whose run is under way gets its next work when
 * that run ends, and its lane asks then), and a change the engine is about to hand over (or, with
 * the app open, one whose backoff the open app runs now). `null` when none is coming.
 */
async function phoneWorkDue(
  executor: DbExecutor,
  device: { accountId: string; deviceId: string; appOpen?: boolean },
): Promise<{ connections: number; inMs: number | null }> {
  const claimableAt = sql<Date>`greatest(
    work.due_at,
    coalesce(work.lease_expires_at, work.due_at),
    coalesce(
      (select max(other.lease_expires_at) from phone_work other
        where other.account_id = work.account_id and other.connection_id = work.connection_id
          and other.id <> work.id),
      work.due_at
    )
  )`;
  const found = await executor
    .selectFrom('marketplace_connection as connection')
    .leftJoin('phone_work as work', (join) =>
      join
        .onRef('work.account_id', '=', 'connection.account_id')
        .onRef('work.connection_id', '=', 'connection.id'),
    )
    .select([
      sql<number>`count(distinct connection.id)::int`.as('connections'),
      sql<number | null>`extract(epoch from min(${claimableAt}) - now())::float8`.as(
        'dueInSeconds',
      ),
    ])
    .where('connection.account_id', '=', device.accountId)
    .where('connection.runs_on', '=', 'phone')
    .where('connection.phone_device_id', '=', device.deviceId)
    .executeTakeFirst();
  if (found === undefined || found.connections === 0) return { connections: 0, inMs: null };
  const operationDue = await nextPhoneOperationDue(executor, device, {
    open: device.appOpen === true,
    staleMs: STALE_HANDOVER_MS,
  });
  const waits = [
    found.dueInSeconds === null ? null : found.dueInSeconds * 1000,
    // The engine hands a due change over within moments.
    operationDue === null ? null : operationDue.getTime() - Date.now() + HANDOVER_SECONDS * 1000,
  ].filter((wait): wait is number => wait !== null);
  return { connections: found.connections, inMs: waits.length === 0 ? null : Math.min(...waits) };
}

/** The longest one wait for phone work holds (under the API gateway's 30-second limit). */
export const PHONE_WAIT_MAX_SECONDS = 20;

/**
 * The open app's wait for its next work (docs/features/phone-execution.md, "When the phone
 * runs"): returns `true` as soon as work for the device may be claimable (handed to the phone
 * meanwhile, or due now), `false` once `maxMs` passed with none, or the request went away. With
 * `signals` listening, new work ends the wait the moment its transaction commits; without them
 * (or while their connection is down) it looks every `PHONE_IDLE_CLAIM_SECONDS`, as the app's
 * claims did before. Reads only: the app claims afterwards.
 */
export async function waitForPhoneWork(
  deps: Pick<PhoneWorkDependencies, 'signals'>,
  executor: DbExecutor,
  device: { accountId: string; deviceId: string },
  options: { maxMs: number; signal?: AbortSignal },
): Promise<boolean> {
  const deadline = Date.now() + options.maxMs;
  for (;;) {
    // Subscribed before the read, so work committed in between still wakes the wait.
    const subscription = deps.signals?.subscribe(device.accountId);
    try {
      const due = await phoneWorkDue(executor, { ...device, appOpen: true });
      if (due.inMs !== null && due.inMs <= 0) return true;
      const listening = deps.signals?.listening === true;
      const look = listening ? Infinity : PHONE_IDLE_CLAIM_SECONDS * 1000;
      const left = deadline - Date.now();
      const wait = Math.min(left, due.inMs ?? Infinity, look);
      if (wait <= 0) return false;
      const woke =
        subscription === undefined
          ? await sleepFor(wait, options.signal)
          : await subscription.wait(wait, options.signal);
      if (woke === 'aborted') return false;
      if (woke === 'timeout') return wait < left;
    } finally {
      subscription?.cancel();
    }
  }
}

function sleepFor(ms: number, signal?: AbortSignal): Promise<'timeout' | 'aborted'> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve('aborted');
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', aborted);
      resolve('timeout');
    }, ms);
    const aborted = (): void => {
      clearTimeout(timer);
      resolve('aborted');
    };
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

/** Takes the phone's answer for the run's current call and returns the next call, if any. */
export async function answerPhoneCall(
  deps: PhoneWorkDependencies,
  answer: { accountId: string; deviceId: string; runId: string; index: number; answer: unknown },
): Promise<PhoneRunState> {
  return inTransaction(deps.db, async (trx) => {
    // The connection before the run's rows, which the answer writes (`lockConnections`).
    const target = await trx
      .selectFrom('phone_work')
      .select('connection_id')
      .where('account_id', '=', answer.accountId)
      .where('id', '=', answer.runId)
      .executeTakeFirst();
    if (target !== undefined) {
      await lockConnections(trx, answer.accountId, [target.connection_id]);
    }
    const work = await trx
      .selectFrom('phone_work as work')
      .innerJoin('marketplace_connection as connection', (join) =>
        join
          .onRef('connection.account_id', '=', 'work.account_id')
          .onRef('connection.id', '=', 'work.connection_id'),
      )
      .selectAll('work')
      .where('work.account_id', '=', answer.accountId)
      .where('work.id', '=', answer.runId)
      .where('connection.phone_device_id', '=', answer.deviceId)
      .forUpdate('work')
      .executeTakeFirst();
    if (work === undefined || work.step === null || work.lease_expires_at === null) {
      throw new PhoneRunGoneError();
    }
    const pending = work.pending_call as unknown as PendingState | null;
    const transcript = entries(work);
    if (pending?.index !== answer.index) {
      // The same answer sent again (a retried request) changes nothing.
      if (answer.index < transcript.length) return state(work, pending);
      throw new PhoneCallConflictError();
    }
    const run = readPhoneAnswer(pending.input.call, answer.answer);
    logAnswered(deps.logger, work, pending, run);
    logStopped(deps.logger, work, pending, run, readPhoneEvidence(answer.answer));
    await finishRun(trx, work, pending.runId, run);
    if (run.type === 'ran' && !run.result.ok && run.result.failure.kind === 'challenge') {
      await discardSession(deps, trx, work, run.result.failure.challenge);
    }
    const next = [...transcript, { key: pending.key, run } satisfies TranscriptEntry];
    const updated = await trx
      .updateTable('phone_work')
      .set({
        transcript: jsonb(JSON.parse(JSON.stringify(next)) as JsonArray),
        pending_call: null,
        lease_expires_at: sql<Date>`now() + make_interval(secs => ${leaseMs(deps) / 1000})`,
      })
      .where('account_id', '=', work.account_id)
      .where('id', '=', work.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return advance(deps, trx, updated);
  });
}

/**
 * Locks the connections the device runs (`lockConnections`) before the claim writes any of
 * their rows: its runs, their work, the checks it starts.
 */
async function lockDeviceConnections(
  trx: DbTransaction,
  device: Pick<ClaimingDevice, 'accountId' | 'deviceId'>,
): Promise<void> {
  const connections = await trx
    .selectFrom('marketplace_connection')
    .select('id')
    .where('account_id', '=', device.accountId)
    .where('phone_device_id', '=', device.deviceId)
    .execute();
  await lockConnections(
    trx,
    device.accountId,
    connections.map((connection) => connection.id),
  );
}

/**
 * The device's runs that stopped. The app says which runs it is still running (`running`, one
 * per marketplace), so a run the device holds besides those stopped in the middle (the app was
 * closed or lost its connection): it ends now instead of when its lease runs out, so the
 * device's other work on that connection does not wait for the lease. Its unanswered call is
 * canceled, and the work is recovered as any lapsed run is.
 */
async function releaseStoppedRuns(
  trx: DbTransaction,
  device: Pick<ClaimingDevice, 'accountId' | 'deviceId' | 'running'>,
): Promise<void> {
  const running = device.running ?? [];
  const held = await trx
    .selectFrom('phone_work as work')
    .innerJoin('marketplace_connection as connection', (join) =>
      join
        .onRef('connection.account_id', '=', 'work.account_id')
        .onRef('connection.id', '=', 'work.connection_id'),
    )
    .select(['work.id', 'work.pending_call'])
    .where('work.account_id', '=', device.accountId)
    .where('connection.phone_device_id', '=', device.deviceId)
    .where('work.lease_expires_at', '>', sql<Date>`now()`)
    .$if(running.length > 0, (query) => query.where('work.id', 'not in', [...running]))
    .forUpdate('work')
    .execute();
  if (held.length === 0) return;
  await trx
    .updateTable('phone_work')
    .set({ lease_expires_at: sql<Date>`now()` })
    .where('account_id', '=', device.accountId)
    .where(
      'id',
      'in',
      held.map((work) => work.id),
    )
    .execute();
  const runs = held.flatMap((work) => {
    const pending = work.pending_call as unknown as PendingState | null;
    return pending === null ? [] : [pending.runId];
  });
  if (runs.length > 0) {
    await trx
      .updateTable('automation_run')
      .set({
        finished_at: sql<Date>`now()`,
        outcome: 'canceled',
        error_code: 'phone_stopped',
        failed_step: 'phone',
      })
      .where('account_id', '=', device.accountId)
      .where('id', 'in', runs)
      .where('finished_at', 'is', null)
      .execute();
  }
}

/** The next work due for the device, locked; one whose connection has a run under way waits. */
async function nextWork(
  trx: DbTransaction,
  device: { accountId: string; deviceId: string; runtimeVersion: number },
): Promise<WorkRow | undefined> {
  return (
    trx
      .selectFrom('phone_work as work')
      // An older runtime has no offer scripts: offers wait for the app's update.
      .$if(device.runtimeVersion < OFFERS_PHONE_RUNTIME_VERSION, (query) =>
        query.where('work.purpose', 'not in', ['offer_check', 'offer_response']),
      )
      .innerJoin('marketplace_connection as connection', (join) =>
        join
          .onRef('connection.account_id', '=', 'work.account_id')
          .onRef('connection.id', '=', 'work.connection_id'),
      )
      .selectAll('work')
      .where('work.account_id', '=', device.accountId)
      .where('connection.runs_on', '=', 'phone')
      .where('connection.phone_device_id', '=', device.deviceId)
      .where('work.due_at', '<=', sql<Date>`now()`)
      .where((eb) =>
        eb.or([
          eb('work.lease_expires_at', 'is', null),
          eb('work.lease_expires_at', '<=', sql<Date>`now()`),
        ]),
      )
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('phone_work as other')
              .select('other.id')
              .whereRef('other.account_id', '=', 'work.account_id')
              .whereRef('other.connection_id', '=', 'work.connection_id')
              .whereRef('other.id', '<>', 'work.id')
              .where('other.lease_expires_at', '>', sql<Date>`now()`),
          ),
        ),
      )
      .orderBy('work.priority')
      .orderBy('work.waiting_since')
      .orderBy('work.id')
      .limit(1)
      .forUpdate('work')
      .skipLocked()
      .executeTakeFirst()
  );
}

/** Claims the work: what its run will do, under a lease. `null` when it has nothing to run. */
async function claim(
  deps: PhoneWorkDependencies,
  trx: DbTransaction,
  work: WorkRow,
): Promise<WorkRow | null> {
  const step = await claimStepState(deps, trx, work);
  if (step === null) {
    await deleteWork(trx, work);
    return null;
  }
  return trx
    .updateTable('phone_work')
    .set({
      claimed_at: sql<Date>`now()`,
      lease_expires_at: sql<Date>`now() + make_interval(secs => ${leaseMs(deps) / 1000})`,
      step: jsonb(step as unknown as JsonObject),
      transcript: jsonb([]),
      pending_call: null,
    })
    .where('account_id', '=', work.account_id)
    .where('id', '=', work.id)
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * The feature a seller's work belongs to, when it is one the seller is shown only once it passed
 * live (docs/features/verified-features.md); `null` for work every marketplace runs (its
 * listing changes, session checks, label reads) and for the operator's sold-history reads.
 */
function workFeature(purpose: WorkRow['purpose']): MarketplaceFeature | null {
  switch (purpose) {
    case 'sale_check':
      return 'sale_checks';
    case 'listing_import':
      return 'listing_import';
    case 'offer_check':
      return 'offers';
    case 'offer_response':
      return 'offer_answers';
    case 'operation':
    case 'session_check':
    case 'sale_history':
    case 'label_read':
      return null;
    default:
      return assertNever(purpose, 'phone work purpose');
  }
}

async function claimStepState(
  deps: PhoneWorkDependencies,
  trx: DbTransaction,
  work: WorkRow,
): Promise<StepState | null> {
  const feature = workFeature(work.purpose);
  // Work of a feature not verified live (queued before it was hidden) is dropped unrun; an
  // answer that may have reached the marketplace still reads its offer back.
  if (
    feature !== null &&
    feature !== 'offer_answers' &&
    !isFeatureOn(work.marketplace, feature, await loadFeatureGate(trx, work.account_id))
  ) {
    return null;
  }
  switch (work.purpose) {
    case 'operation': {
      if (work.operation_id === null) return null;
      const claimed = await claimOperationStep(
        stepDependencies(deps, trx, deps.adapters(new TranscriptSessions([])).lookup, deps.logger),
        { accountId: work.account_id, operationId: work.operation_id },
        'phone',
      );
      // Nothing to run now (the engine rescheduled it), or its connection runs in the cloud now.
      if (claimed.type !== 'step') return null;
      return { kind: 'operation', ref: claimedStepRef(claimed.step) };
    }
    case 'session_check': {
      if (work.check_id === null) return null;
      const prepared = await prepareSessionCheck(
        {
          db: trx,
          automation: deps.adapters(new TranscriptSessions([])).automation,
          logger: deps.logger,
        },
        { accountId: work.account_id, connectionId: work.connection_id, checkId: work.check_id },
      );
      return prepared === null
        ? null
        : { kind: 'session_check', checkId: work.check_id, attempt: prepared.attempt };
    }
    case 'listing_import': {
      if (work.import_id === null) return null;
      const prepared = await prepareImportPage(
        {
          db: trx,
          adapters: deps.adapters(new TranscriptSessions([])).lookup,
          logger: deps.logger,
        },
        { accountId: work.account_id, importId: work.import_id },
      );
      if (prepared === null) return null;
      return { kind: 'listing_import', importId: work.import_id, cursor: prepared.cursor };
    }
    case 'sale_check':
    case 'sale_history': {
      const history = work.purpose === 'sale_history';
      const prepared = await prepareSaleCheck(
        {
          db: trx,
          adapters: deps.adapters(new TranscriptSessions([])).lookup,
          settings: deps.saleChecks,
          logger: deps.logger,
        },
        { accountId: work.account_id, connectionId: work.connection_id },
        history ? 'history' : 'scheduled',
      );
      if (prepared === null) return null;
      const started = await startSaleCheckRun(trx, prepared, 'phone');
      return {
        kind: 'sale_check',
        ...(history ? { history: true } : {}),
        runId: started.runId,
        reason: started.reason,
        since: started.since?.toISOString() ?? null,
        checkedThrough: started.checkedThrough?.toISOString() ?? null,
      };
    }
    case 'label_read': {
      const adapter = deps.adapters(new TranscriptSessions([])).lookup(work.marketplace);
      if (adapter?.readOrderLabels === undefined) return null;
      const orders = await ordersToRead(trx, work.account_id, work.marketplace, new Date());
      return orders.length === 0 ? null : { kind: 'label_read', orders };
    }
    case 'offer_check': {
      const connection = await connectionRef(trx, work);
      const adapter = deps.adapters(new TranscriptSessions([])).lookup(work.marketplace);
      if (
        connection?.mode !== 'automation' ||
        (connection.status !== 'connected' && connection.status !== 'degraded') ||
        adapter?.listOffers === undefined
      ) {
        return null;
      }
      await startOfferCheck(trx, {
        accountId: work.account_id,
        connectionId: work.connection_id,
        marketplace: work.marketplace,
      });
      return { kind: 'offer_check' };
    }
    case 'offer_response': {
      if (work.offer_response_id === null) return null;
      const prepared = await prepareOfferAnswer(trx, {
        accountId: work.account_id,
        responseId: work.offer_response_id,
      });
      if (prepared === null) return null;
      if (!prepared.sent && (await isReadOnlyConnection(trx, work))) {
        // Never sent on a read-only connection.
        await refuseOfferAnswer(trx, prepared);
        return null;
      }
      if (
        !prepared.sent &&
        !isFeatureOn(work.marketplace, 'offer_answers', await loadFeatureGate(trx, work.account_id))
      ) {
        // Never sent where answers haven't passed live: the seller answers in the marketplace.
        await refuseOfferAnswer(trx, prepared, 'unavailable');
        return null;
      }
      await trx
        .updateTable('offer_response')
        .set({ status: 'running' })
        .where('account_id', '=', work.account_id)
        .where('id', '=', prepared.responseId)
        .where('status', '=', 'queued')
        .execute();
      return { kind: 'offer_response', responseId: prepared.responseId, sent: prepared.sent };
    }
    default:
      return null;
  }
}

/**
 * Runs the work with every answer so far: the next call goes to the phone (after the rate limit
 * and the pause between sessions), or the work's result is recorded and the run is over.
 */
async function advance(
  deps: PhoneWorkDependencies,
  trx: DbTransaction,
  initial: WorkRow,
): Promise<PhoneRunState> {
  let work = initial;
  for (;;) {
    const step = work.step as unknown as StepState;
    const transcript = entries(work);
    const explored = await replay(deps, trx, work, step, transcript, SILENT);
    if (explored.type === 'gone' || explored.diverged) {
      // The work changed under the run (the user canceled it, another host took it): the run
      // is over, and the engine's own job deals with whatever the work's state is.
      await deleteWork(trx, work);
      return state(work, null);
    }
    if (explored.pending === null) {
      // Every call is answered: the same run again, logged this time, records the result.
      const final = await replay(deps, trx, work, step, transcript, deps.logger);
      if (final.type === 'gone' || final.diverged || final.pending !== null) {
        await deleteWork(trx, work);
        return state(work, null);
      }
      await final.record();
      return state(work, null);
    }
    const pending = explored.pending;
    const readOnly = await isReadOnlyConnection(trx, work);
    if (readOnly && isWriteCall(pending.request.call)) {
      // Answered by the server: Listora never changes a read-only account
      // (docs/features/read-only.md), so a write script is never handed to the phone.
      deps.logger.warn(
        { connectionId: work.connection_id, script: pending.request.script },
        'refused a write script on a read-only connection',
      );
      const refused: TranscriptEntry = {
        key: callKey(pending.request),
        run: { type: 'read_only' },
      };
      work = await saveTranscript(trx, work, [...transcript, refused]);
      continue;
    }
    const limited = await rateLimitWait(
      trx,
      { accountId: work.account_id, connectionId: work.connection_id },
      profileFor(deps, pending.request).limits,
    );
    if (limited !== null) {
      // Answered by the server: the seller's account had its share of runs for now.
      const answered: TranscriptEntry = {
        key: callKey(pending.request),
        run: { type: 'rate_limited', retryAfterMs: limited },
      };
      work = await saveTranscript(trx, work, [...transcript, answered]);
      continue;
    }
    if (work.purpose === 'offer_response' && isWriteCall(pending.request.call)) {
      // From the moment the phone may send the answer, it is only ever read back, even when
      // this run stops before its answer arrives.
      await trx
        .updateTable('offer_response')
        .set({ sent: true })
        .where('account_id', '=', work.account_id)
        .where('id', '=', (step as Extract<StepState, { kind: 'offer_response' }>).responseId)
        .execute();
    }
    const issued = await issueCall(deps, trx, work, pending, readOnly);
    return state(work, issued);
  }
}

type Replayed =
  | { type: 'gone' }
  | {
      type: 'ran';
      pending: PendingCall | null;
      diverged: boolean;
      /** Records the work's result; only for a run with every call answered. */
      record: () => Promise<void>;
    };

/** Runs the work once with the transcript's answers. */
async function replay(
  deps: PhoneWorkDependencies,
  trx: DbTransaction,
  work: WorkRow,
  step: StepState,
  transcript: readonly TranscriptEntry[],
  logger: Logger,
): Promise<Replayed> {
  const sessions = new TranscriptSessions(transcript);
  const { lookup, automation } = deps.adapters(sessions);
  const signal = new AbortController().signal;
  switch (step.kind) {
    case 'operation': {
      const stepDeps = stepDependencies(deps, trx, lookup, logger);
      const claimed = await loadClaimedStep(stepDeps, step.ref);
      if (claimed === null) return { type: 'gone' };
      const called = await callOperationStep(stepDeps, claimed, signal);
      return {
        type: 'ran',
        pending: sessions.pending,
        diverged: sessions.diverged,
        record: () =>
          recordOperationStep(stepDeps, claimed, called, (recording) =>
            deleteWork(recording, work),
          ),
      };
    }
    case 'session_check': {
      const connection = await connectionRef(trx, work);
      const adapter = isAutomatedMarketplace(work.marketplace)
        ? automation[work.marketplace]
        : undefined;
      if (connection === undefined || adapter === undefined) return { type: 'gone' };
      const health: Health = await adapter.healthCheck({ connection, signal });
      const payload = {
        accountId: work.account_id,
        connectionId: work.connection_id,
        checkId: step.checkId,
      };
      return {
        type: 'ran',
        pending: sessions.pending,
        diverged: sessions.diverged,
        record: async () => {
          await deleteWork(trx, work);
          await recordSessionCheck(
            { db: trx, logger },
            payload,
            { attempt: step.attempt },
            health,
            (delayMs) => retrySessionCheckOnPhone(trx, work, step, delayMs),
          );
        },
      };
    }
    case 'listing_import': {
      const readDeps = { db: trx, adapters: lookup, logger };
      const prepared = await prepareImportPage(readDeps, {
        accountId: work.account_id,
        importId: step.importId,
      });
      if (prepared?.cursor !== step.cursor || prepared.runsOn !== 'phone') {
        return { type: 'gone' };
      }
      let read: { page: ListingsPage } | { error: unknown };
      try {
        read = {
          page: await prepared.adapter.listListings(prepared.cursor, {
            connection: prepared.connection,
            signal,
          }),
        };
      } catch (error) {
        read = { error };
      }
      return {
        type: 'ran',
        pending: sessions.pending,
        diverged: sessions.diverged,
        record: async () => {
          await deleteWork(trx, work);
          if ('page' in read) await recordImportPage(readDeps, prepared, read.page);
          else await recordImportPageFailure(readDeps, prepared, read.error);
        },
      };
    }
    case 'sale_check': {
      const connection = await connectionRef(trx, work);
      const adapter = lookup(work.marketplace);
      if (connection === undefined || adapter?.listOrdersSince === undefined)
        return { type: 'gone' };
      if (step.runId === undefined) return { type: 'gone' };
      const prepared: StartedSaleCheck = {
        key: { accountId: work.account_id, connectionId: work.connection_id },
        marketplace: work.marketplace,
        connection,
        adapter: adapter as StartedSaleCheck['adapter'],
        kind: step.history === true ? 'history' : 'scheduled',
        reason: step.reason ?? 'scheduled',
        since: step.since === null ? null : new Date(step.since),
        checkedThrough: step.checkedThrough === null ? null : new Date(step.checkedThrough),
        runsOn: 'phone',
        runId: step.runId,
      };
      let read: { orders: RemoteOrder[] } | { error: unknown };
      try {
        read = {
          orders: await prepared.adapter.listOrdersSince(prepared.since, { connection, signal }),
        };
      } catch (error) {
        read = { error };
      }
      const checkDeps = { db: trx, settings: deps.saleChecks, logger };
      return {
        type: 'ran',
        pending: sessions.pending,
        diverged: sessions.diverged,
        record: async () => {
          await deleteWork(trx, work);
          if ('orders' in read) await recordSaleCheckOrders(checkDeps, prepared, read.orders);
          else await recordSaleCheckFailure(checkDeps, prepared, read.error);
        },
      };
    }
    case 'offer_check': {
      const connection = await connectionRef(trx, work);
      const adapter = lookup(work.marketplace);
      if (connection === undefined || adapter?.listOffers === undefined) return { type: 'gone' };
      const target = {
        accountId: work.account_id,
        connectionId: work.connection_id,
        marketplace: work.marketplace,
      };
      let read: { offers: RemoteOffer[] } | { error: unknown };
      try {
        read = { offers: await adapter.listOffers({ connection, signal }) };
      } catch (error) {
        read = { error };
      }
      return {
        type: 'ran',
        pending: sessions.pending,
        diverged: sessions.diverged,
        record: async () => {
          await deleteWork(trx, work);
          if ('offers' in read) await recordOffers(trx, target, read.offers, logger);
          else await recordOfferCheckFailure(trx, target, read.error, logger);
        },
      };
    }
    case 'offer_response': {
      const adapter = lookup(work.marketplace);
      const found = await prepareOfferAnswer(trx, {
        accountId: work.account_id,
        responseId: step.responseId,
      });
      if (found === null || adapter === undefined) return { type: 'gone' };
      // The claim's view of whether it was sent, so every run of the work makes the same calls.
      const prepared = { ...found, sent: step.sent };
      const ran = await runOfferAnswer(adapter, prepared, signal);
      return {
        type: 'ran',
        pending: sessions.pending,
        diverged: sessions.diverged,
        record: async () => {
          await deleteWork(trx, work);
          await recordOfferAnswer(trx, prepared, ran, logger);
        },
      };
    }
    case 'label_read': {
      const connection = await connectionRef(trx, work);
      const adapter = lookup(work.marketplace);
      if (connection === undefined || adapter?.readOrderLabels === undefined)
        return { type: 'gone' };
      let read: { labels: RemoteOrderLabel[] } | { error: unknown };
      try {
        read = {
          labels: await adapter.readOrderLabels(
            step.orders.map((order) => ({
              externalOrderId: order.externalOrderId,
              externalListingIds: order.externalListingIds,
            })),
            { connection, signal },
          ),
        };
      } catch (error) {
        read = { error };
      }
      return {
        type: 'ran',
        pending: sessions.pending,
        diverged: sessions.diverged,
        record: async () => {
          await deleteWork(trx, work);
          const results = labelResults(step.orders, read);
          await recordLabelReads(trx, work.account_id, results, new Date());
          await markShippedOnMarketplace(trx, work.account_id, results);
          if ('error' in read) {
            logger.warn(
              { marketplace: work.marketplace, code: readErrorCode(read.error) },
              'a label read failed',
            );
          }
        },
      };
    }
  }
}

/** What a label read found for each order it covered. */
function labelResults(
  orders: readonly LabelReadTarget[],
  read: { labels: RemoteOrderLabel[] } | { error: unknown },
): LabelReadResult[] {
  if ('error' in read) {
    const error = `${readErrorCode(read.error)}: ${read.error instanceof Error ? read.error.message : 'the read failed'}`;
    return orders.map((order) => ({ saleId: order.saleId, status: 'failed', error }));
  }
  return orders.map((order): LabelReadResult => {
    const label = read.labels.find((found) => found.externalOrderId === order.externalOrderId);
    if (!label?.found) return { saleId: order.saleId, status: 'not_found' };
    const found = {
      buyerFirstName: label.buyerFirstName,
      ...(label.orderState === undefined ? {} : { orderState: label.orderState }),
      ...(label.carrierName === undefined ? {} : { carrierName: label.carrierName }),
      ...(label.shipBy === undefined ? {} : { shipBy: label.shipBy }),
      ...(label.labelExpiresAt === undefined ? {} : { labelExpiresAt: label.labelExpiresAt }),
    };
    return label.trackingNumber === null
      ? { saleId: order.saleId, status: 'no_label', ...found }
      : { saleId: order.saleId, status: 'read', trackingNumber: label.trackingNumber, ...found };
  });
}

/**
 * An order its page says shipped (or was delivered) there is shipped, as the seller would mark
 * it and as a sale check records it.
 */
async function markShippedOnMarketplace(
  trx: DbTransaction,
  accountId: string,
  results: readonly LabelReadResult[],
): Promise<void> {
  for (const result of results) {
    if (!('orderState' in result) || result.orderState !== 'shipped') continue;
    try {
      await changeSale(trx, {
        accountId,
        saleId: result.saleId,
        action: 'mark_shipped',
        userId: null,
      });
    } catch (error) {
      // Shipped, canceled, or returned in Listora already.
      if (!(error instanceof SaleStateError)) throw error;
    }
  }
}

function readErrorCode(error: unknown): string {
  return error instanceof AutomationReadError ? error.code : 'read_failed';
}

/** A session check whose marketplace could not be read waits for the phone again, later. */
async function retrySessionCheckOnPhone(
  trx: DbTransaction,
  work: WorkRow,
  step: Extract<StepState, { kind: 'session_check' }>,
  delayMs: number,
): Promise<void> {
  const updated = await trx
    .updateTable('session_check')
    .set({ attempts: step.attempt })
    .where('account_id', '=', work.account_id)
    .where('connection_id', '=', work.connection_id)
    .where('check_id', '=', step.checkId)
    .where('status', '=', 'pending')
    .executeTakeFirst();
  if (updated.numUpdatedRows === 0n) return;
  await queueSessionCheckForPhone(
    trx,
    {
      accountId: work.account_id,
      connectionId: work.connection_id,
      marketplace: work.marketplace,
      checkId: step.checkId,
    },
    delayMs,
  );
}

/** Hands the pending call to the phone: its run record, the pause, and the call itself. */
async function issueCall(
  deps: PhoneWorkDependencies,
  trx: DbTransaction,
  work: WorkRow,
  pending: PendingCall,
  readOnly: boolean,
): Promise<PendingState> {
  const { request } = pending;
  const profile = profileFor(deps, request);
  const startDelayMs = continuesSession(work) ? 0 : await sessionGapLeft(trx, work, profile);
  const run = await trx
    .insertInto('automation_run')
    .values({
      account_id: work.account_id,
      connection_id: work.connection_id,
      marketplace: work.marketplace,
      purpose: request.purpose,
      script: request.script.slice(0, 100),
      operation_id: request.purpose === 'operation' ? request.operationId : null,
      host: 'phone',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const input: PhoneCallInput = {
    runtimeVersion: await deviceRuntimeVersion(trx, work),
    scriptSet: request.scriptSet,
    call: request.call,
    name: request.script,
    origins: [...profile.origins],
    apiOrigins: [...profile.apiOrigins],
    cookieDomains: [...profile.cookieDomains],
    pacing: readOnly ? profile.readOnlyPacing : profile.pacing,
    stepTimeoutMs: deps.stepTimeoutMs,
    callTimeoutMs: deps.callTimeoutMs,
    startDelayMs,
    ...(readOnly ? { readOnly } : {}),
  };
  const issued: PendingState = {
    index: pending.index,
    key: callKey(request),
    runId: run.id,
    input,
  };
  await trx
    .updateTable('phone_work')
    .set({
      pending_call: jsonb(JSON.parse(JSON.stringify(issued)) as JsonObject),
      lease_expires_at: sql<Date>`now() + make_interval(secs => ${leaseMs(deps) / 1000})`,
    })
    .where('account_id', '=', work.account_id)
    .where('id', '=', work.id)
    .execute();
  return issued;
}

/**
 * Whether the call goes on a session the phone is in: the run already had a call of its own
 * answered by the phone (a send's read-back after the send, a create's lookup before it). Its
 * calls are one visit to the marketplace, as a person checks a listing right after posting it,
 * so only a run's first call waits out the pause between sessions.
 */
function continuesSession(work: WorkRow): boolean {
  return entries(work).some((entry) => entry.run.type === 'ran');
}

/** The rest of the pause since the seller's last session on the connection started. */
async function sessionGapLeft(
  trx: DbTransaction,
  work: WorkRow,
  profile: AutomationProfile,
): Promise<number> {
  const last = await trx
    .selectFrom('automation_run')
    .select('started_at')
    .where('account_id', '=', work.account_id)
    .where('connection_id', '=', work.connection_id)
    .orderBy('started_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (last === undefined) return 0;
  const gap = new Pacing(profile.pacing).delayMs('session');
  return Math.max(0, last.started_at.getTime() + gap - Date.now());
}

/** The marketplace's profile as the call's adapter runs it (on its stand-in site in development). */
function profileFor(deps: PhoneWorkDependencies, request: SessionRequest): AutomationProfile {
  const { marketplace, siteUrl } = request.scriptSet;
  const configured = deps.profiles[marketplace];
  return configured.origins.includes(new URL(siteUrl).origin)
    ? configured
    : standInProfile(configured, siteUrl);
}

/**
 * Every call the phone answered, with how long each of its steps took there: what a run spent
 * its time on, for the operator (`phone call answered`).
 */
function logAnswered(
  logger: Logger,
  work: WorkRow,
  pending: PendingState,
  run: ReturnType<typeof readPhoneAnswer>,
): void {
  const result = run.type === 'ran' ? run.result : null;
  const stepMs = result?.stepMs ?? null;
  logger.info(
    {
      host: 'phone',
      runId: pending.runId,
      connectionId: work.connection_id,
      marketplace: work.marketplace,
      purpose: work.purpose,
      operationId: work.operation_id,
      script: pending.input.name,
      ok: result?.ok ?? false,
      steps: result?.steps ?? [],
      ...(stepMs === null ? {} : { stepMs }),
    },
    'phone call answered',
  );
}

/**
 * A call the phone's run stopped, logged as the runner logs its own (`automation script
 * stopped`): the phone keeps no screenshot, so its step, its reason, and what a page it no
 * longer understood had instead (structure only) are the run's evidence.
 */
function logStopped(
  logger: Logger,
  work: WorkRow,
  pending: PendingState,
  run: ReturnType<typeof readPhoneAnswer>,
  evidence: PageEvidence | null,
): void {
  if (run.type !== 'ran' || run.result.ok) return;
  const { failure, mutated } = run.result;
  logger.warn(
    {
      host: 'phone',
      runId: pending.runId,
      connectionId: work.connection_id,
      marketplace: work.marketplace,
      script: pending.input.name,
      step: failure.step,
      failure: failure.kind,
      ...(failure.kind === 'challenge' ? { challenge: failure.challenge } : {}),
      ...(failure.kind === 'error' ? { code: failure.code, reason: failure.message } : {}),
      ...(evidence === null ? {} : { evidence }),
      mutated,
    },
    'automation script stopped',
  );
}

/** Finishes the call's `automation_run` with how it went. */
async function finishRun(
  trx: DbTransaction,
  work: WorkRow,
  runId: string,
  run: ReturnType<typeof readPhoneAnswer>,
): Promise<void> {
  const result = run.type === 'ran' ? run.result : null;
  const failure = result === null || result.ok ? null : result.failure;
  await trx
    .updateTable('automation_run')
    .set({
      finished_at: sql<Date>`now()`,
      outcome: result === null ? 'failed' : runOutcome(result),
      challenge_kind: failure?.kind === 'challenge' ? failure.challenge : null,
      failed_step: result === null ? 'start' : failure === null ? null : failure.step.slice(0, 100),
      error_code:
        result === null
          ? 'session_missing'
          : failure === null
            ? null
            : failure.kind === 'error'
              ? failure.code
              : failure.kind,
      steps: result === null ? null : jsonb(runSteps(result)),
    })
    .where('account_id', '=', work.account_id)
    .where('id', '=', runId)
    .execute();
}

/**
 * A check the seller won't pass: the stored session is discarded and the connection waits for
 * a relink, with one reconnect task, as when the runner meets one.
 */
async function discardSession(
  deps: PhoneWorkDependencies,
  trx: DbTransaction,
  work: WorkRow,
  challenge: Parameters<typeof challengeMessage>[0],
): Promise<void> {
  const connection = await trx
    .selectFrom('marketplace_connection')
    .select('credential_version')
    .where('account_id', '=', work.account_id)
    .where('id', '=', work.connection_id)
    .executeTakeFirst();
  if (connection === undefined || deps.vault === undefined) return;
  await deps.vault.markNeedsRelink(
    trx,
    {
      accountId: work.account_id,
      connectionId: work.connection_id,
      version: connection.credential_version,
    },
    { kind: challenge, message: challengeMessage(challenge, MARKETPLACE_NAMES[work.marketplace]) },
  );
}

function stepDependencies(
  deps: PhoneWorkDependencies,
  db: DbExecutor,
  adapters: AdapterLookup,
  logger: Logger,
): StepDependencies {
  return {
    db,
    adapters,
    logger,
    policy: deps.policy,
    // The phone keeps its own deadline; the server's runs of the step answer at once.
    callTimeoutMs: deps.callTimeoutMs,
    blockedRecheckMs: deps.blockedRecheckMs,
    ...(deps.phone === undefined ? {} : { phone: deps.phone }),
  };
}

async function connectionRef(
  trx: DbTransaction,
  work: WorkRow,
): Promise<ConnectionRef | undefined> {
  return trx
    .selectFrom('marketplace_connection')
    .select(['id', 'mode', 'status'])
    .where('account_id', '=', work.account_id)
    .where('id', '=', work.connection_id)
    .executeTakeFirst();
}

/**
 * The runtime version the work's phone speaks, as it last claimed: the calls it is handed say
 * that version, which an older runtime checks.
 */
async function deviceRuntimeVersion(trx: DbTransaction, work: WorkRow): Promise<number> {
  const device = await trx
    .selectFrom('marketplace_connection as connection')
    .innerJoin('app_device as device', (join) =>
      join
        .onRef('device.account_id', '=', 'connection.account_id')
        .onRef('device.id', '=', 'connection.phone_device_id'),
    )
    .select('device.runtime_version')
    .where('connection.account_id', '=', work.account_id)
    .where('connection.id', '=', work.connection_id)
    .executeTakeFirst();
  const version = device?.runtime_version ?? PHONE_RUNTIME_VERSION;
  return SUPPORTED_PHONE_RUNTIME_VERSIONS.includes(version) ? version : PHONE_RUNTIME_VERSION;
}

/** Whether the work's connection is read only (docs/features/read-only.md). */
async function isReadOnlyConnection(trx: DbTransaction, work: WorkRow): Promise<boolean> {
  const connection = await trx
    .selectFrom('marketplace_connection')
    .select('read_only')
    .where('account_id', '=', work.account_id)
    .where('id', '=', work.connection_id)
    .executeTakeFirst();
  return connection?.read_only === true;
}

function entries(work: WorkRow): TranscriptEntry[] {
  return work.transcript as unknown as TranscriptEntry[];
}

async function saveTranscript(
  trx: DbTransaction,
  work: WorkRow,
  transcript: readonly TranscriptEntry[],
): Promise<WorkRow> {
  return trx
    .updateTable('phone_work')
    .set({ transcript: jsonb(JSON.parse(JSON.stringify(transcript)) as JsonArray) })
    .where('account_id', '=', work.account_id)
    .where('id', '=', work.id)
    .returningAll()
    .executeTakeFirstOrThrow();
}

async function deleteWork(
  trx: DbExecutor,
  work: Pick<WorkRow, 'account_id' | 'id'>,
): Promise<void> {
  await trx
    .deleteFrom('phone_work')
    .where('account_id', '=', work.account_id)
    .where('id', '=', work.id)
    .execute();
}

function leaseMs(deps: PhoneWorkDependencies): number {
  return deps.leaseMs ?? DEFAULT_LEASE_MS;
}

function state(work: WorkRow, pending: PendingState | null): PhoneRunState {
  return {
    id: work.id,
    purpose: work.purpose,
    marketplace: work.marketplace,
    operationId: work.operation_id,
    call: pending === null ? null : { index: pending.index, input: pending.input },
  };
}
