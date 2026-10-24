import { describe, expect, it } from 'vitest';

import {
  METRIC_DIMENSIONS,
  METRIC_NAMESPACE,
  TRUST_METRICS,
  type TrustMetricName,
} from './catalog.ts';
import { createMetricsEmitter, formatEmf, MAX_VALUES_PER_LINE, type MetricGroup } from './emf.ts';

const AT = new Date('2026-10-24T12:00:00.000Z');

function parse(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}

describe('the trust metric catalog', () => {
  it('uses CloudWatch units and few, known dimensions per set', () => {
    for (const [name, metric] of Object.entries(TRUST_METRICS)) {
      expect(name).toMatch(/^[A-Z][A-Za-z]+$/);
      expect(['Count', 'Seconds', 'Milliseconds', 'None']).toContain(metric.unit);
      expect(metric.dimensionSets.length).toBeGreaterThan(0);
      for (const set of metric.dimensionSets) {
        expect(set.length).toBeLessThanOrEqual(2);
        for (const dimension of set) expect(METRIC_DIMENSIONS).toContain(dimension);
      }
    }
  });
});

describe('formatEmf', () => {
  it('writes one EMF line: the _aws directive, dimension values, and metric values', () => {
    const group: MetricGroup = {
      timestamp: AT,
      dimensions: { Status: 'verifying' },
      values: { StuckOperations: [3], OldestStuckOperationAge: [120, 60] },
    };
    const lines = formatEmf(group, { service: 'worker' });

    expect(lines).toHaveLength(1);
    expect(parse(lines[0] ?? '')).toEqual({
      service: 'worker',
      Status: 'verifying',
      _aws: {
        Timestamp: AT.getTime(),
        CloudWatchMetrics: [
          {
            Namespace: METRIC_NAMESPACE,
            Dimensions: [['Status']],
            Metrics: [
              { Name: 'StuckOperations', Unit: 'Count' },
              { Name: 'OldestStuckOperationAge', Unit: 'Seconds' },
            ],
          },
        ],
      },
      // A single value is written as a number, as CloudWatch's own libraries do.
      StuckOperations: 3,
      OldestStuckOperationAge: [120, 60],
    });
  });

  it('publishes verified success per marketplace and kind, and per marketplace alone', () => {
    const [line] = formatEmf({
      timestamp: AT,
      dimensions: { Marketplace: 'ebay', Kind: 'end' },
      values: { VerifiedSuccess: [1, 1, 0] },
    });
    expect(parse(line ?? '')).toMatchObject({
      Marketplace: 'ebay',
      Kind: 'end',
      VerifiedSuccess: [1, 1, 0],
      _aws: { CloudWatchMetrics: [{ Dimensions: [['Marketplace', 'Kind'], ['Marketplace']] }] },
    });
  });

  it('publishes a metric under every dimension set, including none', () => {
    const [line] = formatEmf({
      timestamp: AT,
      dimensions: { AccountId: 'account-1' },
      values: { AiDailyCostUsd: [0.25] },
    });
    expect(parse(line ?? '')).toMatchObject({
      AccountId: 'account-1',
      AiDailyCostUsd: 0.25,
      _aws: { CloudWatchMetrics: [{ Dimensions: [['AccountId'], []] }] },
    });
  });

  it('splits more than 100 values of a metric across lines', () => {
    const values = Array.from({ length: 2 * MAX_VALUES_PER_LINE + 5 }, (_, index) => index);
    const lines = formatEmf({
      timestamp: AT,
      dimensions: { Marketplace: 'depop' },
      values: { DelistLatency: values },
    }).map(parse);

    expect(lines.map((line) => (line['DelistLatency'] as number[]).length)).toEqual([100, 100, 5]);
    expect(lines.flatMap((line) => line['DelistLatency'] as number[])).toEqual(values);
  });

  it('refuses groups that CloudWatch would drop or misfile', () => {
    expect(() => formatEmf({ timestamp: AT, dimensions: {}, values: {} })).toThrow(
      'at least one metric',
    );
    expect(() =>
      formatEmf({ timestamp: AT, dimensions: {}, values: { VerifiedSuccess: [1] } }),
    ).toThrow('dimension Marketplace is missing');
    expect(() =>
      formatEmf({
        timestamp: AT,
        dimensions: { Marketplace: 'ebay', Kind: 'create' },
        values: { VerifiedSuccess: [1], OperationFailed: [0] },
      }),
    ).toThrow('different dimensions');
    expect(() =>
      formatEmf({ timestamp: AT, dimensions: {}, values: { DelistFailed: [Number.NaN] } }),
    ).toThrow('not a finite number');
  });

  it('names every metric with its catalog unit', () => {
    const units = Object.fromEntries(
      (Object.keys(TRUST_METRICS) as TrustMetricName[]).map((name) => [
        name,
        TRUST_METRICS[name].unit,
      ]),
    );
    expect(units).toEqual({
      VerifiedSuccess: 'Count',
      OperationFailed: 'Count',
      DelistFailed: 'Count',
      DelistLatency: 'Milliseconds',
      StuckOperations: 'Count',
      OldestStuckOperationAge: 'Seconds',
      OldestUnverifiedOperationAge: 'Seconds',
      AiDailyCostUsd: 'None',
      MarketplaceConnections: 'Count',
      ConnectionsNeedingRelink: 'Count',
    });
  });
});

describe('createMetricsEmitter', () => {
  it('writes every line of every group, tagged with the service', () => {
    const lines: string[] = [];
    const emitter = createMetricsEmitter({ service: 'worker', write: (line) => lines.push(line) });
    emitter.emit([
      { timestamp: AT, dimensions: {}, values: { DelistFailed: [2] } },
      { timestamp: AT, dimensions: {}, values: { ConnectionsNeedingRelink: [0] } },
    ]);

    expect(lines.map(parse)).toEqual([
      expect.objectContaining({ service: 'worker', DelistFailed: 2 }),
      expect.objectContaining({ service: 'worker', ConnectionsNeedingRelink: 0 }),
    ]);
  });
});
