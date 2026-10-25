/**
 * The worker's trust metrics job: Graphile Worker's cron runs it once a minute across all
 * workers (never twice for the same minute), and after downtime it fills in the minutes it
 * missed, up to an hour back.
 *
 * The tick for minute T publishes the operations that settled in [T - 2 min, T - 1 min). The
 * minute of lag lets the transactions that started in the window commit (each records its
 * events at its start, and none stays open during a marketplace call). Every scheduled tick
 * also publishes the current state, timestamped when it runs; a filled-in tick does not, since
 * the next scheduled one publishes it.
 */
import type { Db } from '@listora/db';
import type { Logger } from '@listora/shared';

import type { MetricsEmitter } from './emf.ts';
import { collectCurrentState, collectSettledOperations } from './trust-metrics.ts';

export const TRUST_METRICS_TASK = 'trust_metrics';

/**
 * Graphile runs lower priorities first. The job runs ahead of every operation step (priority 0,
 * or -10 for delists after a sale), so a queue full of operations cannot silence the alarms
 * that watch them; it is a few cheap queries.
 */
export const TRUST_METRICS_PRIORITY = -20;

/** Every minute, filled in up to an hour back, with a few attempts (a database outage). */
export const TRUST_METRICS_CRONTAB = `* * * * * ${TRUST_METRICS_TASK} ?fill=1h&max=5&priority=${String(TRUST_METRICS_PRIORITY)}`;

const MINUTE_MS = 60_000;

export interface TrustMetricsDependencies {
  readonly db: Db;
  readonly emitter: MetricsEmitter;
  readonly logger: Logger;
  readonly now?: () => Date;
}

/** The minute a cron job was scheduled for, from Graphile's `_cron` payload. */
export function cronTick(payload: unknown): { ts: Date; backfilled: boolean } | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const cron = (payload as Record<string, unknown>)['_cron'];
  if (typeof cron !== 'object' || cron === null) return undefined;
  const { ts, backfilled } = cron as Record<string, unknown>;
  const date = typeof ts === 'string' ? new Date(ts) : undefined;
  if (date === undefined || Number.isNaN(date.getTime())) return undefined;
  return { ts: date, backfilled: backfilled === true };
}

/** Runs one tick. Throws when the database fails, so Graphile retries it. */
export async function runTrustMetricsTick(
  deps: TrustMetricsDependencies,
  payload: unknown,
): Promise<void> {
  const tick = cronTick(payload);
  if (tick === undefined) {
    deps.logger.error('trust metrics job without a cron timestamp; skipping it');
    return;
  }
  const window = {
    from: new Date(tick.ts.getTime() - 2 * MINUTE_MS),
    to: new Date(tick.ts.getTime() - MINUTE_MS),
  };
  const groups = await collectSettledOperations(deps.db, window);
  if (!tick.backfilled) {
    groups.push(...(await collectCurrentState(deps.db, deps.now?.() ?? new Date())));
  }
  deps.emitter.emit(groups);
}
