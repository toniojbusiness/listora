/**
 * Phone runs (docs/features/phone-execution.md): the server's half of running automated work
 * on the seller's iPhone. Work handed to the phone waits in `phone_work`: an operation step the
 * engine handed over (`@listora/operations`, phone-queue.ts), a session check, or a sale check.
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
  type Db,
  type DbExecutor,
  type DbTransaction,
  type JsonArray,
  type JsonObject,
  type Marketplace,
  type PhoneWorkPurpose,
  type PhoneWorkTable,
} from '@listora/db';
import type { SessionVault } from '@listora/connections';
import {
  MARKETPLACE_NAMES,
  type AdapterLookup,
  type ConnectionRef,
  type Health,
  type MarketplaceAdapter,
  type RemoteOrder,
} from '@listora/marketplaces';
import {
  callOperationStep,
  claimedStepRef,
  claimOperationStep,
  loadClaimedStep,
  recordOperationStep,
  type ClaimedStepRef,
  type PhoneQueueSettings,
  type RetryPolicy,
  type StepDependencies,
} from '@listora/operations';
import { createLogger, type Logger } from '@listora/shared';

import type { AutomationSessions, SessionRequest } from '../adapter/sessions.ts';
import { rateLimitWait, runOutcome } from '../adapter/runner-sessions.ts';
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
  type PreparedSaleCheck,
} from '../sale-checks/job.ts';
import type { SaleCheckSettings } from '../settings.ts';
import { prepareSessionCheck, recordSessionCheck } from '../session-checks/job.ts';
import { queueSessionCheckForPhone } from '../session-checks/schedule.ts';
import { readPhoneAnswer, readPhoneEvidence, readPhoneTimings } from './answers.ts';
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
/** The longest a phone that runs marketplaces waits between looks while the app is open. */
export const PHONE_IDLE_CLAIM_SECONDS = 10;
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
  | { kind: 'sale_check'; since: string | null; checkedThrough: string | null };

/** The call the phone runs now. */
interface PendingState {
  index: number;
  key: string;
  runId: string;
  input: PhoneCallInput;
}

/**
 * Claims the device's next due work and returns its first call, or `null` when nothing waits
 * for it. Runs in `executor`, the request's transaction.
 */
export async function claimPhoneRun(
  deps: PhoneWorkDependencies,
  executor: DbExecutor,
  device: { accountId: string; deviceId: string; runtimeVersion: number },
): Promise<PhoneRunState | null> {
  if (device.runtimeVersion !== PHONE_RUNTIME_VERSION) throw new PhoneRuntimeMismatchError();
  return inTransaction(executor, async (trx) => {
    await releaseStoppedRuns(trx, device);
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
 * check tried again after a failed attempt), and never longer than `PHONE_IDLE_CLAIM_SECONDS`
 * while marketplaces run on it, so work queued meanwhile (a sale check, a delist after a sale)
 * starts within seconds without a push; a phone that runs none asks rarely.
 */
export async function nextPhoneClaimSeconds(
  executor: DbExecutor,
  device: { accountId: string; deviceId: string },
): Promise<number> {
  // Work is claimable once it is due and no run holds it.
  const claimableAt = sql<Date>`greatest(work.due_at, coalesce(work.lease_expires_at, work.due_at))`;
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
  if (found === undefined || found.connections === 0) return PHONE_UNUSED_CLAIM_SECONDS;
  if (found.dueInSeconds === null) return PHONE_IDLE_CLAIM_SECONDS;
  return Math.min(PHONE_IDLE_CLAIM_SECONDS, Math.max(1, Math.ceil(found.dueInSeconds)));
}

/** Takes the phone's answer for the run's current call and returns the next call, if any. */
export async function answerPhoneCall(
  deps: PhoneWorkDependencies,
  answer: { accountId: string; deviceId: string; runId: string; index: number; answer: unknown },
): Promise<PhoneRunState> {
  return inTransaction(deps.db, async (trx) => {
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
    logAnswered(deps.logger, work, pending, run, readPhoneTimings(answer.answer));
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
 * The device's runs that stopped. The app runs one thing at a time and asks for work only when
 * it runs none, so a run the device still holds stopped in the middle (the app was closed or
 * lost its connection): it ends now instead of when its lease runs out, so the device's other
 * work on that connection does not wait for the lease. Its unanswered call is canceled, and the
 * work is recovered as any lapsed run is.
 */
async function releaseStoppedRuns(
  trx: DbTransaction,
  device: { accountId: string; deviceId: string },
): Promise<void> {
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
  device: { accountId: string; deviceId: string },
): Promise<WorkRow | undefined> {
  return trx
    .selectFrom('phone_work as work')
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
    .executeTakeFirst();
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

async function claimStepState(
  deps: PhoneWorkDependencies,
  trx: DbTransaction,
  work: WorkRow,
): Promise<StepState | null> {
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
    case 'sale_check': {
      const prepared = await prepareSaleCheck(
        {
          db: trx,
          adapters: deps.adapters(new TranscriptSessions([])).lookup,
          settings: deps.saleChecks,
          logger: deps.logger,
        },
        { accountId: work.account_id, connectionId: work.connection_id },
      );
      return prepared === null
        ? null
        : {
            kind: 'sale_check',
            since: prepared.since?.toISOString() ?? null,
            checkedThrough: prepared.checkedThrough?.toISOString() ?? null,
          };
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
    const issued = await issueCall(deps, trx, work, pending);
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
    case 'sale_check': {
      const connection = await connectionRef(trx, work);
      const adapter = lookup(work.marketplace);
      if (connection === undefined || adapter?.listOrdersSince === undefined)
        return { type: 'gone' };
      const prepared: PreparedSaleCheck = {
        key: { accountId: work.account_id, connectionId: work.connection_id },
        marketplace: work.marketplace,
        connection,
        adapter: adapter as PreparedSaleCheck['adapter'],
        since: step.since === null ? null : new Date(step.since),
        checkedThrough: step.checkedThrough === null ? null : new Date(step.checkedThrough),
        runsOn: 'phone',
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
  }
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
): Promise<PendingState> {
  const { request } = pending;
  const profile = profileFor(deps, request);
  const last = await trx
    .selectFrom('automation_run')
    .select('started_at')
    .where('account_id', '=', work.account_id)
    .where('connection_id', '=', work.connection_id)
    .orderBy('started_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  const gap = new Pacing(profile.pacing).delayMs('session');
  const startDelayMs =
    last === undefined ? 0 : Math.max(0, last.started_at.getTime() + gap - Date.now());
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
    runtimeVersion: PHONE_RUNTIME_VERSION,
    scriptSet: request.scriptSet,
    call: request.call,
    name: request.script,
    origins: [...profile.origins],
    cookieDomains: [...profile.cookieDomains],
    pacing: profile.pacing,
    stepTimeoutMs: deps.stepTimeoutMs,
    callTimeoutMs: deps.callTimeoutMs,
    startDelayMs,
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
  stepMs: number[] | null,
): void {
  const result = run.type === 'ran' ? run.result : null;
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
