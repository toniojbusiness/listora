import {
  createMetricsEmitter,
  runTrustMetricsTick,
  TRUST_METRICS_CRONTAB,
  TRUST_METRICS_TASK,
} from '@listora/observability';

import type { WorkerFeature } from '../features.ts';

/**
 * The trust metrics (`trust_metrics`, every minute): published from the worker as CloudWatch
 * embedded metrics, which the observability stack alarms on (docs/features/observability.md).
 */
export const feature: WorkerFeature = {
  jobs: ({ db, logger }) => {
    const metrics = { db, emitter: createMetricsEmitter({ service: 'worker' }), logger };
    return {
      tasks: { [TRUST_METRICS_TASK]: (payload) => runTrustMetricsTick(metrics, payload) },
      crontab: [TRUST_METRICS_CRONTAB],
    };
  },
};
