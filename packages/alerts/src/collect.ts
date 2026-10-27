import { METRIC_NAMESPACE, type TrustMetricName } from '@listora/observability/catalog';

import type {
  AlarmFirings,
  BackupStatus,
  CostSummary,
  FiringAlarm,
  HealthSnapshot,
  MarketplaceWeek,
  Section,
  WorkerWeek,
} from './summary.ts';

/** One statistic of one trust metric over the whole week. */
export interface MetricQuery {
  /** Unique per query; letters and digits, starting with a lowercase letter. */
  readonly id: string;
  readonly metricName: TrustMetricName;
  readonly statistic: string;
  readonly dimensions?: Readonly<Record<string, string>>;
}

/** What the summary reads from AWS; `AwsHealthReader` reads it, tests use a fake. */
export interface HealthReader {
  /** Alarms whose names start with `prefix` that are in ALARM now. */
  firingAlarms(prefix: string): Promise<readonly FiringAlarm[]>;
  /** How often each alarm whose name starts with `prefix` went into ALARM between the dates. */
  alarmFirings(prefix: string, start: Date, end: Date): Promise<readonly AlarmFirings[]>;
  /** Each query's single value over the period; null where the metric has no data. */
  weekMetrics(
    namespace: string,
    queries: readonly MetricQuery[],
    start: Date,
    end: Date,
  ): Promise<ReadonlyMap<string, number | null>>;
  /** Unblended cost of the whole account, this month so far and last month. */
  cost(now: Date): Promise<Omit<CostSummary, 'monthlyThresholdUsd'>>;
  backups(instanceId: string): Promise<BackupStatus>;
}

export interface SummaryConfig {
  readonly environment: string;
  readonly databaseInstanceId: string;
  readonly marketplaces: readonly string[];
  readonly monthlyCostThresholdUsd: number;
}

const HOUR_MS = 60 * 60_000;
const WEEK_MS = 7 * 24 * HOUR_MS;

async function read<T>(load: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, value: await load() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The metric query id of one marketplace's statistic (`VerifiedSuccess`, `ebay`, `rate`). */
function queryId(name: string, marketplace: string): string {
  return `${name}${marketplace.replace(/[^A-Za-z0-9]/g, '')}`;
}

/**
 * Reads the week that ends at the last whole hour before `now` into a snapshot. Each section is read on its own, so one
 * failed read (a missing permission, an AWS outage) still leaves the rest of the summary, and
 * says what could not be read.
 */
export async function collectHealth(
  reader: HealthReader,
  config: SummaryConfig,
  now: Date,
): Promise<HealthSnapshot> {
  // Whole hours, so CloudWatch answers each query over the week with exactly one period.
  const weekEnd = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
  const weekStart = new Date(weekEnd.getTime() - WEEK_MS);
  const prefix = `listora-${config.environment}-`;
  const marketplaceQueries = config.marketplaces.flatMap((marketplace): MetricQuery[] => {
    const dimensions = { Marketplace: marketplace };
    return [
      {
        id: queryId('rate', marketplace),
        metricName: 'VerifiedSuccess',
        statistic: 'Average',
        dimensions,
      },
      {
        id: queryId('settled', marketplace),
        metricName: 'VerifiedSuccess',
        statistic: 'SampleCount',
        dimensions,
      },
      {
        id: queryId('latency', marketplace),
        metricName: 'DelistLatency',
        statistic: 'p95',
        dimensions,
      },
    ];
  });
  const workerQueries: MetricQuery[] = [
    // Published once a minute whatever the state, so its samples count the minutes reported.
    { id: 'heartbeat', metricName: 'OldestUnverifiedOperationAge', statistic: 'SampleCount' },
    { id: 'delistfailed', metricName: 'DelistFailed', statistic: 'Sum' },
    { id: 'aicost', metricName: 'AiDailyCostUsd', statistic: 'Maximum' },
  ];
  const metrics = read(() =>
    reader.weekMetrics(
      METRIC_NAMESPACE,
      [...marketplaceQueries, ...workerQueries],
      weekStart,
      weekEnd,
    ),
  );

  const [firing, firings, metricValues, cost, backups] = await Promise.all([
    read(() => reader.firingAlarms(prefix)),
    read(() => reader.alarmFirings(prefix, weekStart, weekEnd)),
    metrics,
    read(async () => ({
      ...(await reader.cost(now)),
      monthlyThresholdUsd: config.monthlyCostThresholdUsd,
    })),
    read(() => reader.backups(config.databaseInstanceId)),
  ]);

  const fromMetrics = <T>(build: (value: (id: string) => number | null) => T): Section<T> =>
    metricValues.ok
      ? { ok: true, value: build((id) => metricValues.value.get(id) ?? null) }
      : metricValues;

  const marketplaces = fromMetrics((value): readonly MarketplaceWeek[] =>
    config.marketplaces.map((marketplace) => ({
      marketplace,
      settled: value(queryId('settled', marketplace)) ?? 0,
      verifiedSuccessRate: value(queryId('rate', marketplace)),
      delistLatencyP95Ms: value(queryId('latency', marketplace)),
    })),
  );
  const worker = fromMetrics((value): WorkerWeek => ({
    minutesReporting: value('heartbeat') ?? 0,
    minutesInWeek: WEEK_MS / 60_000,
    failedDelists: value('delistfailed') ?? 0,
    maxAiDailyCostUsd: value('aicost'),
  }));

  return {
    environment: config.environment,
    weekStart,
    weekEnd,
    firing,
    firings,
    marketplaces,
    worker,
    cost,
    backups,
  };
}
