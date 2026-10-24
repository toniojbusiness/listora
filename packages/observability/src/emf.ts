/**
 * CloudWatch Embedded Metric Format (EMF): a metric is a JSON log line with an `_aws`
 * directive. CloudWatch Logs extracts the metrics from the container's log group as the lines
 * arrive, so publishing needs no agent, API call, or IAM permission beyond writing logs.
 * https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html
 */
import { writeSync } from 'node:fs';

import {
  METRIC_NAMESPACE,
  TRUST_METRICS,
  type MetricDimension,
  type TrustMetricName,
} from './catalog.ts';

/** CloudWatch takes at most 100 values of one metric in one line. */
export const MAX_VALUES_PER_LINE = 100;

/**
 * Values of one or more metrics that share their dimensions, at one time. Every metric in a
 * group must have the same dimension sets in the catalog.
 */
export interface MetricGroup {
  readonly timestamp: Date;
  readonly dimensions: Partial<Readonly<Record<MetricDimension, string>>>;
  readonly values: Partial<Readonly<Record<TrustMetricName, readonly number[]>>>;
}

/** Formats a group as EMF lines (more than one when a metric has over 100 values). */
export function formatEmf(group: MetricGroup, properties: Record<string, string> = {}): string[] {
  const entries = Object.entries(group.values) as [TrustMetricName, readonly number[]][];
  const first = entries[0];
  if (first === undefined) throw new Error('a metric group needs at least one metric');
  const dimensionSets = TRUST_METRICS[first[0]].dimensionSets;
  for (const [name, values] of entries) {
    if (JSON.stringify(TRUST_METRICS[name].dimensionSets) !== JSON.stringify(dimensionSets)) {
      throw new Error(`${name} and ${first[0]} have different dimensions`);
    }
    if (!values.every((value) => Number.isFinite(value))) {
      throw new Error(`${name} has a value that is not a finite number`);
    }
  }
  for (const dimension of new Set(dimensionSets.flat())) {
    const value = group.dimensions[dimension];
    if (value === undefined || value === '') throw new Error(`dimension ${dimension} is missing`);
  }

  const lines: string[] = [];
  const longest = Math.max(...entries.map(([, values]) => values.length));
  for (let start = 0; start < longest; start += MAX_VALUES_PER_LINE) {
    const chunk = entries
      .map(([name, values]) => [name, values.slice(start, start + MAX_VALUES_PER_LINE)] as const)
      .filter(([, values]) => values.length > 0);
    lines.push(
      JSON.stringify({
        ...properties,
        ...group.dimensions,
        _aws: {
          Timestamp: group.timestamp.getTime(),
          CloudWatchMetrics: [
            {
              Namespace: METRIC_NAMESPACE,
              Dimensions: dimensionSets,
              Metrics: chunk.map(([name]) => ({ Name: name, Unit: TRUST_METRICS[name].unit })),
            },
          ],
        },
        ...Object.fromEntries(
          chunk.map(([name, values]) => [name, values.length === 1 ? values[0] : values]),
        ),
      }),
    );
  }
  return lines;
}

/** Writes metric groups as EMF lines; `write` receives one line at a time, without newline. */
export interface MetricsEmitter {
  emit(groups: readonly MetricGroup[]): void;
}

export interface MetricsEmitterOptions {
  /** Process name, as in the logs (`service`). */
  service: string;
  /**
   * Defaults to a synchronous write to stdout, where the container's log driver sends it to
   * CloudWatch Logs. Metrics are written whatever the log level is.
   */
  write?: (line: string) => void;
}

export function createMetricsEmitter(options: MetricsEmitterOptions): MetricsEmitter {
  const write =
    options.write ??
    ((line: string) => {
      writeSync(1, `${line}\n`);
    });
  return {
    emit(groups) {
      for (const group of groups) {
        for (const line of formatEmf(group, { service: options.service })) write(line);
      }
    },
  };
}
