import {
  CloudWatchClient,
  DescribeAlarmHistoryCommand,
  DescribeAlarmsCommand,
  GetMetricDataCommand,
  type MetricDataQuery,
} from '@aws-sdk/client-cloudwatch';
import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
import {
  DescribeDBInstancesCommand,
  DescribeDBSnapshotsCommand,
  RDSClient,
} from '@aws-sdk/client-rds';

import type { HealthReader, MetricQuery } from './collect.ts';
import type { AlarmFirings, BackupStatus, CostSummary, FiringAlarm } from './summary.ts';

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Reads the weekly summary's data from CloudWatch, Cost Explorer, and RDS. */
export class AwsHealthReader implements HealthReader {
  private readonly cloudwatch = new CloudWatchClient({});
  // Cost Explorer has one endpoint, in us-east-1, whatever the environment's region.
  private readonly costExplorer = new CostExplorerClient({ region: 'us-east-1' });
  private readonly rds = new RDSClient({});

  async firingAlarms(prefix: string): Promise<readonly FiringAlarm[]> {
    const firing: FiringAlarm[] = [];
    let nextToken: string | undefined;
    do {
      const page = await this.cloudwatch.send(
        new DescribeAlarmsCommand({
          AlarmNamePrefix: prefix,
          StateValue: 'ALARM',
          NextToken: nextToken,
        }),
      );
      for (const alarm of page.MetricAlarms ?? []) {
        firing.push({
          id: (alarm.AlarmName ?? '').slice(prefix.length),
          description: alarm.AlarmDescription ?? '',
          since: alarm.StateUpdatedTimestamp ?? new Date(),
        });
      }
      nextToken = page.NextToken;
    } while (nextToken !== undefined);
    return firing;
  }

  async alarmFirings(prefix: string, start: Date, end: Date): Promise<readonly AlarmFirings[]> {
    // The history cannot be filtered by name prefix, so the account's whole history is read.
    const counts = new Map<string, number>();
    let nextToken: string | undefined;
    do {
      const page = await this.cloudwatch.send(
        new DescribeAlarmHistoryCommand({
          HistoryItemType: 'StateUpdate',
          StartDate: start,
          EndDate: end,
          NextToken: nextToken,
        }),
      );
      for (const item of page.AlarmHistoryItems ?? []) {
        const name = item.AlarmName ?? '';
        if (!name.startsWith(prefix) || item.HistoryData === undefined) continue;
        const data = JSON.parse(item.HistoryData) as { newState?: { stateValue?: string } };
        if (data.newState?.stateValue !== 'ALARM') continue;
        const id = name.slice(prefix.length);
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      nextToken = page.NextToken;
    } while (nextToken !== undefined);
    return [...counts]
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  }

  async weekMetrics(
    namespace: string,
    queries: readonly MetricQuery[],
    start: Date,
    end: Date,
  ): Promise<ReadonlyMap<string, number | null>> {
    // One period covering the whole range: each query answers with one value or none.
    const period = Math.ceil((end.getTime() - start.getTime()) / 3_600_000) * 3600;
    const metricQueries: MetricDataQuery[] = queries.map((query) => ({
      Id: query.id,
      MetricStat: {
        Metric: {
          Namespace: namespace,
          MetricName: query.metricName,
          Dimensions: Object.entries(query.dimensions ?? {}).map(([Name, Value]) => ({
            Name,
            Value,
          })),
        },
        Period: period,
        Stat: query.statistic,
      },
    }));
    const values = new Map<string, number | null>(queries.map((query) => [query.id, null]));
    let nextToken: string | undefined;
    do {
      const page = await this.cloudwatch.send(
        new GetMetricDataCommand({
          MetricDataQueries: metricQueries,
          StartTime: start,
          EndTime: end,
          NextToken: nextToken,
        }),
      );
      for (const result of page.MetricDataResults ?? []) {
        const value = result.Values?.[0];
        if (result.Id !== undefined && value !== undefined) values.set(result.Id, value);
      }
      nextToken = page.NextToken;
    } while (nextToken !== undefined);
    return values;
  }

  async cost(now: Date): Promise<Omit<CostSummary, 'monthlyThresholdUsd'>> {
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const lastMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    // The end date is exclusive; tomorrow includes today's cost so far.
    const tomorrow = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
    );
    const result = await this.costExplorer.send(
      new GetCostAndUsageCommand({
        TimePeriod: { Start: isoDay(lastMonthStart), End: isoDay(tomorrow) },
        Granularity: 'MONTHLY',
        Metrics: ['UnblendedCost'],
      }),
    );
    const amount = (start: Date): number => {
      const period = result.ResultsByTime?.find(
        (entry) => entry.TimePeriod?.Start === isoDay(start),
      );
      return Number(period?.Total?.['UnblendedCost']?.Amount ?? 0);
    };
    return { monthToDateUsd: amount(monthStart), lastMonthUsd: amount(lastMonthStart) };
  }

  async backups(instanceId: string): Promise<BackupStatus> {
    const described = await this.rds.send(
      new DescribeDBInstancesCommand({ DBInstanceIdentifier: instanceId }),
    );
    const instance = described.DBInstances?.[0];
    if (instance === undefined) throw new Error(`no database instance ${instanceId}`);
    const snapshots = await this.rds.send(
      new DescribeDBSnapshotsCommand({
        DBInstanceIdentifier: instanceId,
        SnapshotType: 'automated',
      }),
    );
    const newest = (snapshots.DBSnapshots ?? [])
      .map((snapshot) => snapshot.SnapshotCreateTime)
      .filter((created): created is Date => created !== undefined)
      .sort((a, b) => b.getTime() - a.getTime())[0];
    return {
      instanceId,
      retentionDays: instance.BackupRetentionPeriod ?? 0,
      deletionProtection: instance.DeletionProtection ?? false,
      latestRestorableTime: instance.LatestRestorableTime ?? null,
      latestSnapshotTime: newest ?? null,
    };
  }
}
