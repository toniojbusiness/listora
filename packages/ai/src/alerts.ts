import { sql } from 'kysely';

import type { DbExecutor } from '@listora/db';
import type { Logger } from '@listora/shared';

import { QUOTA_METRICS, type QuotaMetric } from './guards.ts';
import { parseUtcDay } from './reports.ts';

/** When the spend check raises an alert (from `loadAiAlertConfig`). */
export interface AiAlertThresholds {
  /** The per-account daily circuit breaker (`AI_DAILY_BUDGET_USD`), in micro-dollars. */
  readonly dailyBudgetMicros: number;
  /** Spend by every account together, per UTC day, that raises the global alert. */
  readonly globalDailyAlertMicros: number;
  /** An account or the platform is "approaching" a limit from this percentage of it on. */
  readonly warnPercent: number;
}

export const AI_ALERT_SEVERITIES = ['approaching', 'over'] as const;
export type AiAlertSeverity = (typeof AI_ALERT_SEVERITIES)[number];

/**
 * One limit that is close or reached. `over` for the daily budget means the circuit breaker
 * has tripped: the account's AI calls are refused until the next UTC day.
 */
export type AiSpendAlert =
  | {
      readonly kind: 'account_daily_budget';
      readonly severity: AiAlertSeverity;
      readonly accountId: string;
      readonly spentMicros: number;
      readonly limitMicros: number;
    }
  | {
      readonly kind: 'account_quota';
      readonly severity: AiAlertSeverity;
      readonly accountId: string;
      readonly metric: QuotaMetric;
      readonly used: number;
      readonly quota: number;
      /** First day after the quota period (`YYYY-MM-DD`), when the counter resets. */
      readonly periodEnd: string;
    }
  | {
      readonly kind: 'global_daily_spend';
      readonly severity: AiAlertSeverity;
      readonly spentMicros: number;
      readonly thresholdMicros: number;
    };

export interface AiSpendCheck {
  /** The UTC day checked (`YYYY-MM-DD`); today comes from the database clock, like the guard's. */
  readonly day: string;
  readonly globalSpentMicros: number;
  readonly killSwitchEngaged: boolean;
  readonly blockedAccounts: number;
  /**
   * One alert per limit, at its highest severity: the global alert, then daily budgets by
   * spend, then quotas by the share used.
   */
  readonly alerts: readonly AiSpendAlert[];
}

/**
 * The scheduled AI spend check: flags accounts approaching or over their daily circuit
 * breaker or a plan quota, and the platform approaching or over its global daily spend
 * threshold. It only reads; the guards in `AiClient` do the refusing.
 *
 * Each alert is logged as `event: "ai_spend_alert"` (warn when approaching, error when
 * over), followed by one `event: "ai_spend_check"` summary line with numeric counts, so
 * CloudWatch metric filters and alarms can key on the fields. The field names are a contract
 * with those alarms; change them only together.
 */
export async function checkAiSpend(
  db: DbExecutor,
  thresholds: AiAlertThresholds,
  options: {
    readonly logger?: Logger;
    /** The UTC day to check (`YYYY-MM-DD`); today on the database clock by default. */
    readonly day?: string;
  } = {},
): Promise<AiSpendCheck> {
  validThresholds(thresholds);
  const day =
    options.day === undefined
      ? (
          await db
            .selectNoFrom(sql<string>`(now() at time zone 'UTC')::date::text`.as('day'))
            .executeTakeFirstOrThrow()
        ).day
      : utcDay(parseUtcDay(options.day));

  const budgetWarnAt = percentOf(thresholds.dailyBudgetMicros, thresholds.warnPercent);
  const budgetRows = await db
    .selectFrom('ai_usage_daily')
    .select(['account_id', 'cost_micros'])
    .where('usage_date', '=', day)
    .where('cost_micros', '>=', budgetWarnAt)
    .orderBy('cost_micros', 'desc')
    .orderBy('account_id')
    .execute();

  const quotaRows = await db
    .selectFrom('usage_counter')
    .select(['account_id', 'metric', 'used', 'quota', 'period_end'])
    .where('metric', 'in', QUOTA_METRICS)
    .where('period_start', '<=', day)
    .where('period_end', '>', day)
    // A zero quota means the plan has none of that unit; there is nothing to approach.
    .where('quota', '>', 0)
    .where(sql<boolean>`used::bigint * 100 >= quota::bigint * ${thresholds.warnPercent}`)
    .orderBy(sql`used::numeric / quota`, 'desc')
    .orderBy('account_id')
    .orderBy('metric')
    .execute();

  const global = await db
    .selectFrom('ai_usage_daily')
    .select(sql<number>`coalesce(sum(cost_micros), 0)::bigint`.as('spent'))
    .where('usage_date', '=', day)
    .executeTakeFirstOrThrow();
  const killSwitch = await db
    .selectFrom('ai_kill_switch')
    .select('engaged')
    .executeTakeFirstOrThrow();
  const blocks = await db
    .selectFrom('ai_account_block')
    .select(sql<number>`count(*)`.as('count'))
    .executeTakeFirstOrThrow();

  const alerts: AiSpendAlert[] = [];
  const globalWarnAt = percentOf(thresholds.globalDailyAlertMicros, thresholds.warnPercent);
  if (global.spent >= globalWarnAt) {
    alerts.push({
      kind: 'global_daily_spend',
      severity: global.spent >= thresholds.globalDailyAlertMicros ? 'over' : 'approaching',
      spentMicros: global.spent,
      thresholdMicros: thresholds.globalDailyAlertMicros,
    });
  }
  for (const row of budgetRows) {
    alerts.push({
      kind: 'account_daily_budget',
      // The same comparison as the guard: a call is refused once spend reaches the limit.
      severity: row.cost_micros >= thresholds.dailyBudgetMicros ? 'over' : 'approaching',
      accountId: row.account_id,
      spentMicros: row.cost_micros,
      limitMicros: thresholds.dailyBudgetMicros,
    });
  }
  for (const row of quotaRows) {
    const metric = QUOTA_METRICS.find((known) => known === row.metric);
    if (metric === undefined || row.quota === null) continue;
    alerts.push({
      kind: 'account_quota',
      severity: row.used >= row.quota ? 'over' : 'approaching',
      accountId: row.account_id,
      metric,
      used: row.used,
      quota: row.quota,
      periodEnd: row.period_end,
    });
  }

  const check: AiSpendCheck = {
    day,
    globalSpentMicros: global.spent,
    killSwitchEngaged: killSwitch.engaged,
    blockedAccounts: blocks.count,
    alerts,
  };
  if (options.logger !== undefined) logSpendCheck(options.logger, check, thresholds);
  return check;
}

function logSpendCheck(logger: Logger, check: AiSpendCheck, thresholds: AiAlertThresholds): void {
  for (const alert of check.alerts) {
    const { kind, ...fields } = alert;
    const line = { event: 'ai_spend_alert', alert: kind, day: check.day, ...fields };
    if (alert.severity === 'over') logger.error(line, alertMessage(alert));
    else logger.warn(line, alertMessage(alert));
  }
  const count = (kind: AiSpendAlert['kind'], severity: AiAlertSeverity) =>
    check.alerts.filter((alert) => alert.kind === kind && alert.severity === severity).length;
  const global = check.alerts.find((alert) => alert.kind === 'global_daily_spend');
  logger.info(
    {
      event: 'ai_spend_check',
      day: check.day,
      globalSpentMicros: check.globalSpentMicros,
      globalDailyAlertMicros: thresholds.globalDailyAlertMicros,
      globalDailySpend: global?.severity ?? 'ok',
      accountsOverDailyBudget: count('account_daily_budget', 'over'),
      accountsApproachingDailyBudget: count('account_daily_budget', 'approaching'),
      quotasOver: count('account_quota', 'over'),
      quotasApproaching: count('account_quota', 'approaching'),
      killSwitchEngaged: check.killSwitchEngaged,
      blockedAccounts: check.blockedAccounts,
    },
    'AI spend check',
  );
}

function alertMessage(alert: AiSpendAlert): string {
  const state = alert.severity === 'over' ? 'reached' : 'approaching';
  switch (alert.kind) {
    case 'account_daily_budget':
      return `account ${state} its AI daily budget`;
    case 'account_quota':
      return `account ${state} its ${alert.metric} quota`;
    case 'global_daily_spend':
      return `AI spend across all accounts ${state} the global daily alert threshold`;
  }
}

/** `percent` of `micros`, rounded up, without losing precision on large budgets. */
function percentOf(micros: number, percent: number): number {
  return Number((BigInt(micros) * BigInt(percent) + 99n) / 100n);
}

function validThresholds(thresholds: AiAlertThresholds): void {
  const { dailyBudgetMicros, globalDailyAlertMicros, warnPercent } = thresholds;
  if (!Number.isSafeInteger(dailyBudgetMicros) || dailyBudgetMicros < 0) {
    throw new RangeError('dailyBudgetMicros must be a non-negative integer');
  }
  if (!Number.isSafeInteger(globalDailyAlertMicros) || globalDailyAlertMicros < 1) {
    throw new RangeError('globalDailyAlertMicros must be a positive integer');
  }
  if (!Number.isInteger(warnPercent) || warnPercent < 1 || warnPercent > 100) {
    throw new RangeError('warnPercent must be an integer from 1 to 100');
  }
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
