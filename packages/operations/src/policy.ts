/**
 * How often and how long the engine keeps trying one operation (docs/features/operations.md).
 *
 * Every step of an operation (sending it, or reading the listing back to verify it) uses one
 * attempt. After attempt n the next step waits `delaysMs[n - 1]` (the last delay repeats),
 * jittered so that many operations failing together do not retry together. An operation gets
 * `delaysMs.length + 1` attempts, then fails with a Retry action. The one exception: a step
 * whose result is unknown is always followed by a verification step, so an exhausted budget
 * never turns "maybe applied" into "failed" without reading the listing back first.
 */

/** 30 s, 2 m, 10 m, 30 m, 2 h, 6 h: seven attempts over about nine hours. */
export const RETRY_DELAYS_MS: readonly number[] = [
  30_000, 120_000, 600_000, 1_800_000, 7_200_000, 21_600_000,
];

export interface RetryPolicy {
  /** Delay after attempt n is `delaysMs[min(n, length) - 1]`. Must not be empty. */
  readonly delaysMs: readonly number[];
  /** Each delay is randomized by up to this fraction in either direction (0.2 = ±20%). */
  readonly jitter: number;
  /** A number in [0, 1); injectable for tests. */
  readonly random: () => number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  delaysMs: RETRY_DELAYS_MS,
  jitter: 0.2,
  random: Math.random,
};

/**
 * The default schedule with every delay multiplied by `scale` (0 < scale <= 1), keeping the
 * number of attempts. Only local stacks and tests shorten it (`OPERATION_RETRY_DELAY_SCALE`),
 * so an eBay confirmation, which needs two matching reads one delay apart, takes seconds there.
 */
export function scaledRetryPolicy(scale: number): RetryPolicy {
  if (!(scale > 0 && scale <= 1)) throw new RangeError('the retry delay scale must be in (0, 1]');
  return {
    ...DEFAULT_RETRY_POLICY,
    delaysMs: DEFAULT_RETRY_POLICY.delaysMs.map((delay) => Math.round(delay * scale)),
  };
}

/**
 * How often an idle worker asks the queue for jobs that became due: a sixth of the shortest
 * retry delay, between 2 s and 5 s (5 s with the default schedule; 2 s, as before, with the
 * local stack's shortened one). New jobs never wait for
 * it (Graphile Worker hears of them through LISTEN/NOTIFY); only future-dated ones do (retries,
 * read-backs, rechecks), and those are at least 30 s away in production, so a 5 s poll delays
 * them by under a sixth. Each worker slot polls on its own, so this is most of an idle worker's
 * database traffic (docs/features/performance.md).
 */
export function queuePollIntervalMs(policy: RetryPolicy): number {
  const shortest = Math.min(...policy.delaysMs);
  return Math.min(5_000, Math.max(2_000, Math.round(shortest / 6)));
}

/** Attempts an operation gets before it fails (7 with the default schedule). */
export function maxAttempts(policy: RetryPolicy): number {
  return policy.delaysMs.length + 1;
}

/**
 * The wait before the step after `attempt`. A marketplace's `Retry-After` is honored, capped at
 * the longest delay of the schedule.
 */
export function delayAfterAttempt(
  policy: RetryPolicy,
  attempt: number,
  retryAfterMs?: number,
): number {
  const longest = Math.max(...policy.delaysMs);
  const base = policy.delaysMs[Math.min(Math.max(attempt, 1), policy.delaysMs.length) - 1] ?? 0;
  const jittered = Math.round(base * (1 + policy.jitter * (2 * policy.random() - 1)));
  return Math.max(0, jittered, Math.min(retryAfterMs ?? 0, longest));
}
