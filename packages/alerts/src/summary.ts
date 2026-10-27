import type { Email } from './mailer.ts';

/** A section the summary read, or why it could not: a failed read is reported, never skipped. */
export type Section<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

export interface FiringAlarm {
  /** Without the `listora-<env>-` prefix. */
  readonly id: string;
  readonly description: string;
  readonly since: Date;
}

export interface AlarmFirings {
  readonly id: string;
  /** Times the alarm went into ALARM during the week. */
  readonly count: number;
}

export interface MarketplaceWeek {
  readonly marketplace: string;
  /** Operations that settled (succeeded or failed) during the week. */
  readonly settled: number;
  /** Of those, the share that succeeded with a verified result; null when none settled. */
  readonly verifiedSuccessRate: number | null;
  /** p95 from the sale being recorded to the verified delist; null without delists. */
  readonly delistLatencyP95Ms: number | null;
}

export interface WorkerWeek {
  /** Minutes in which the worker published its trust metrics (it does so every minute). */
  readonly minutesReporting: number;
  readonly minutesInWeek: number;
  readonly failedDelists: number;
  /** The highest one account's AI cost reached in one UTC day; null without AI use. */
  readonly maxAiDailyCostUsd: number | null;
}

export interface CostSummary {
  readonly monthToDateUsd: number;
  readonly lastMonthUsd: number;
  /** The monthly budget whose alerts go to the alarm topic. */
  readonly monthlyThresholdUsd: number;
}

export interface BackupStatus {
  readonly instanceId: string;
  readonly retentionDays: number;
  readonly deletionProtection: boolean;
  /** Point-in-time restore reaches up to here; null when RDS reports none (backups off). */
  readonly latestRestorableTime: Date | null;
  readonly latestSnapshotTime: Date | null;
}

export interface HealthSnapshot {
  readonly environment: string;
  readonly weekStart: Date;
  readonly weekEnd: Date;
  readonly firing: Section<readonly FiringAlarm[]>;
  readonly firings: Section<readonly AlarmFirings[]>;
  readonly marketplaces: Section<readonly MarketplaceWeek[]>;
  readonly worker: Section<WorkerWeek>;
  readonly cost: Section<CostSummary>;
  readonly backups: Section<BackupStatus>;
}

/** The worker publishing for fewer minutes than this share of the week is worth a look. */
const WORKER_REPORTING_TARGET = 0.99;
/** Point-in-time restore normally lags the present by about five minutes. */
const RESTORE_LAG_LIMIT_MINUTES = 15;

function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function time(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** Rounded down, so a share short of all of it never reads 100%. */
function percent(share: number): string {
  return `${(Math.floor(share * 1000) / 10).toFixed(1)}%`;
}

function duration(ms: number): string {
  const minutes = ms / 60_000;
  if (minutes < 1) return `${String(Math.round(ms / 1000))} s`;
  if (minutes < 120) return `${minutes.toFixed(minutes < 10 ? 1 : 0)} min`;
  return `${(minutes / 60).toFixed(1)} h`;
}

function section<T>(
  title: string,
  read: Section<T>,
  render: (value: T) => { lines: string[]; attention: string[] },
): { lines: string[]; attention: string[] } {
  if (!read.ok) {
    return {
      lines: [title, `  Could not read: ${read.error}`],
      attention: [`${title}: could not be read (${read.error}).`],
    };
  }
  const { lines, attention } = render(read.value);
  return { lines: [title, ...lines.map((line) => `  ${line}`)], attention };
}

/**
 * The weekly health summary: what needs attention first, then each part of the system over the
 * week. Its subject says whether anything needs attention, so a healthy week reads at a glance
 * and a bad one is never mistaken for it.
 */
export function weeklySummaryEmail(snapshot: HealthSnapshot, now: Date): Email {
  const parts = [
    section('Alarms firing now', snapshot.firing, (firing) => ({
      lines:
        firing.length === 0
          ? ['None.']
          : firing.map((alarm) => `${alarm.id} (since ${time(alarm.since)}): ${alarm.description}`),
      attention: firing.map((alarm) => `${alarm.id} is firing.`),
    })),
    section('Alarms that fired this week', snapshot.firings, (firings) => ({
      lines:
        firings.length === 0
          ? ['None.']
          : firings.map(
              (alarm) => `${alarm.id}: ${String(alarm.count)} time${alarm.count === 1 ? '' : 's'}`,
            ),
      attention: [],
    })),
    section('Marketplace operations this week', snapshot.marketplaces, (marketplaces) => ({
      lines: marketplaces.map((week) => {
        if (week.settled === 0) return `${week.marketplace}: no operations settled`;
        const rate = week.verifiedSuccessRate === null ? '?' : percent(week.verifiedSuccessRate);
        const latency =
          week.delistLatencyP95Ms === null
            ? ''
            : `, p95 delist ${duration(week.delistLatencyP95Ms)}`;
        return `${week.marketplace}: ${String(week.settled)} settled, ${rate} verified success${latency}`;
      }),
      attention: marketplaces
        .filter((week) => week.verifiedSuccessRate !== null && week.verifiedSuccessRate < 0.9)
        .map(
          (week) =>
            `${week.marketplace}: only ${percent(week.verifiedSuccessRate ?? 0)} of operations ` +
            'succeeded with a verified result.',
        ),
    })),
    section('Worker', snapshot.worker, (worker) => {
      // A late tick after downtime can add a sample to a minute that has one, so cap the share.
      const share =
        worker.minutesInWeek === 0
          ? 0
          : Math.min(1, worker.minutesReporting / worker.minutesInWeek);
      const attention: string[] = [];
      if (share < WORKER_REPORTING_TARGET) {
        attention.push(
          `The worker reported in only ${percent(share)} of the week's minutes: it was down or stuck.`,
        );
      }
      if (worker.failedDelists > 0) {
        attention.push(`${String(worker.failedDelists)} delists failed this week.`);
      }
      return {
        lines: [
          `Reported in ${percent(share)} of minutes (${String(worker.minutesReporting)} of ` +
            `${String(worker.minutesInWeek)})`,
          `Failed delists: ${String(worker.failedDelists)}`,
          `Highest AI cost of one account in a day: ${
            worker.maxAiDailyCostUsd === null ? 'no AI use' : usd(worker.maxAiDailyCostUsd)
          }`,
        ],
        attention,
      };
    }),
    section('AWS cost (whole account)', snapshot.cost, (cost) => ({
      lines: [
        `This month so far: ${usd(cost.monthToDateUsd)} (budget ${usd(cost.monthlyThresholdUsd)})`,
        `Last month: ${usd(cost.lastMonthUsd)}`,
      ],
      attention:
        cost.monthToDateUsd >= cost.monthlyThresholdUsd
          ? [`AWS cost this month (${usd(cost.monthToDateUsd)}) is over the budget.`]
          : [],
    })),
    section('Database backups', snapshot.backups, (backups) => {
      const attention: string[] = [];
      const restorable = backups.latestRestorableTime;
      const lagMinutes =
        restorable === null ? null : (now.getTime() - restorable.getTime()) / 60_000;
      if (backups.retentionDays === 0) attention.push('Automated database backups are off.');
      if (!backups.deletionProtection) attention.push('Database deletion protection is off.');
      if (lagMinutes === null || lagMinutes > RESTORE_LAG_LIMIT_MINUTES) {
        attention.push(
          'Point-in-time restore is behind: the newest changes may not be restorable.',
        );
      }
      return {
        lines: [
          `${backups.instanceId}: automated backups kept ${String(backups.retentionDays)} days, ` +
            `deletion protection ${backups.deletionProtection ? 'on' : 'OFF'}`,
          `Restorable to: ${
            restorable === null ? 'nothing (no point-in-time restore)' : time(restorable)
          }`,
          `Newest automated snapshot: ${
            backups.latestSnapshotTime === null ? 'none' : time(backups.latestSnapshotTime)
          }`,
        ],
        attention,
      };
    }),
  ];

  const attention = parts.flatMap((part) => part.attention);
  const period = `${day(snapshot.weekStart)} to ${day(snapshot.weekEnd)}`;
  const status =
    attention.length === 0
      ? 'all healthy'
      : `${String(attention.length)} thing${attention.length === 1 ? '' : 's'} need${attention.length === 1 ? 's' : ''} attention`;
  return {
    subject: `[Listora ${snapshot.environment}] Weekly health: ${status}`,
    text: [
      `Listora ${snapshot.environment}, week of ${period}.`,
      '',
      ...(attention.length === 0
        ? ['Nothing needs attention.']
        : ['Needs attention:', ...attention.map((line) => `- ${line}`)]),
      '',
      ...parts.flatMap((part) => [...part.lines, '']),
      'What each alarm means and what to do first: docs/features/alerts.md in the Listora repository.',
    ].join('\n'),
  };
}
