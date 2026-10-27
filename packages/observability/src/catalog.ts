/**
 * The trust metrics: the name, unit, and dimensions of every metric Listora publishes. The
 * worker emits them (trust-metrics.ts) and the CDK alarms read them (infra), so this file has
 * no dependencies: infra imports it as `@listora/observability/catalog`.
 *
 * Every environment is its own AWS account, so one namespace serves all of them. CloudWatch
 * bills each distinct name and dimension values as one custom metric, for the hours it
 * receives data, so dimensions stay few and low in cardinality (docs/features/costs.md).
 */

export const METRIC_NAMESPACE = 'Listora';

/** The CloudWatch units these metrics use. */
export type MetricUnit = 'Count' | 'Seconds' | 'Milliseconds' | 'None';

export interface MetricDefinition {
  readonly unit: MetricUnit;
  /**
   * The dimension sets CloudWatch aggregates each value under. `[]` is the metric without
   * dimensions, across every value of the others (what an environment-wide alarm reads).
   */
  readonly dimensionSets: readonly (readonly MetricDimension[])[];
  readonly description: string;
}

export const METRIC_DIMENSIONS = ['Marketplace', 'Kind', 'Status', 'AccountId'] as const;
export type MetricDimension = (typeof METRIC_DIMENSIONS)[number];

export const TRUST_METRICS = {
  VerifiedSuccess: {
    unit: 'Count',
    dimensionSets: [['Marketplace', 'Kind'], ['Marketplace']],
    description:
      'One sample per settled operation: 1 when it succeeded (verified by read-back or ' +
      'confirmed by the user), 0 when it failed. Average is the verified-success rate, per ' +
      'marketplace and kind, and per marketplace.',
  },
  OperationFailed: {
    unit: 'Count',
    dimensionSets: [['Marketplace', 'Kind']],
    description: 'Operations that failed (Sum), per marketplace and operation kind.',
  },
  DelistFailed: {
    unit: 'Count',
    dimensionSets: [[]],
    description: 'Delists (end or mark-sold operations) that failed, on any marketplace (Sum).',
  },
  DelistLatency: {
    unit: 'Milliseconds',
    dimensionSets: [['Marketplace']],
    description:
      'From the sale being recorded to the verified delist of another listing of the item, ' +
      'one sample per auto-delist operation that succeeded (p50, p95).',
  },
  DelistEverywhereLatency: {
    unit: 'Milliseconds',
    dimensionSets: [[]],
    description:
      'From the sale being recorded to the last other listing of the item delisted and ' +
      'confirmed, one sample per sale whose every delist succeeded (p50, p95; target under a ' +
      'minute, docs/features/auto-delist.md).',
  },
  StuckOperations: {
    unit: 'Count',
    dimensionSets: [['Status']],
    description: 'Operations now verifying, retrying, or waiting for the user.',
  },
  OldestStuckOperationAge: {
    unit: 'Seconds',
    dimensionSets: [['Status']],
    description:
      'Age of the oldest operation now in the status, since it was last queued (0 for none).',
  },
  OldestUnverifiedOperationAge: {
    unit: 'Seconds',
    dimensionSets: [[]],
    description:
      'Age of the oldest operation not yet verified or failed (queued, running, retrying, or ' +
      'verifying), since it was last queued; 0 for none. Operations waiting for the user are ' +
      'counted by StuckOperations instead.',
  },
  AiDailyCostUsd: {
    unit: 'None',
    dimensionSets: [['AccountId'], []],
    description:
      "An account's AI cost so far today (UTC), in US dollars. Without dimensions, Maximum is " +
      'the highest account.',
  },
  MarketplaceConnections: {
    unit: 'Count',
    dimensionSets: [['Marketplace', 'Status']],
    description: 'Marketplace connections per status, for the statuses that have any.',
  },
  ConnectionsNeedingRelink: {
    unit: 'Count',
    dimensionSets: [[]],
    description: 'Connections the seller must link again (reauth_required or revoked).',
  },
  UnhealthySaleChecks: {
    unit: 'Count',
    dimensionSets: [['Marketplace'], []],
    description:
      'Working automation connections whose sale checks fail or stopped running ' +
      '(`failing` or `overdue`, docs/features/activity.md): sales there are not being seen, so ' +
      'a sold item may stay for sale elsewhere. Published per marketplace that has any; without ' +
      'dimensions, Maximum is the worst marketplace.',
  },
  OverdueDeletions: {
    unit: 'Count',
    dimensionSets: [[]],
    description:
      'Account and connection deletions still unfinished past their completion deadline (8 ' +
      'days): personal data that should be gone may still be held (docs/features/privacy.md).',
  },
} as const satisfies Record<string, MetricDefinition>;

export type TrustMetricName = keyof typeof TRUST_METRICS;
