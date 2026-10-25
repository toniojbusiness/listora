import { describe, expect, it } from 'vitest';

import { TRUST_METRICS_CRONTAB, TRUST_METRICS_PRIORITY } from '@listora/observability';
import { OPERATION_PRIORITY } from '@listora/operations';

describe('the trust metrics schedule', () => {
  it('runs ahead of every operation step, so a busy queue still publishes the current state', () => {
    expect(TRUST_METRICS_PRIORITY).toBeLessThan(Math.min(...Object.values(OPERATION_PRIORITY)));
    expect(TRUST_METRICS_CRONTAB).toMatch(
      new RegExp(`[?&]priority=${String(TRUST_METRICS_PRIORITY)}(&|$)`),
    );
  });
});
