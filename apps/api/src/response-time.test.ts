import fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { createMetricsEmitter } from '@listora/observability';

import {
  isTimedOperation,
  LONG_POLL_OPERATIONS,
  registerResponseTimeMetric,
} from './response-time.ts';

function recordingEmitter() {
  const lines: Record<string, unknown>[] = [];
  const metrics = createMetricsEmitter({
    service: 'api',
    write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { metrics, lines };
}

describe('the API response time metric', () => {
  it('times every contract operation but the long polls, and nothing outside the contract', () => {
    expect(isTimedOperation('listItems')).toBe(true);
    expect(isTimedOperation('claimPhoneRun')).toBe(true);
    expect(isTimedOperation('waitForPhoneWork')).toBe(false);
    expect(isTimedOperation('waitForItemChange')).toBe(false);
    expect(isTimedOperation('researchScan')).toBe(false);
    expect(isTimedOperation(undefined)).toBe(false);
    expect([...LONG_POLL_OPERATIONS]).toHaveLength(3);
  });

  it('writes one ApiResponseTime value per timed response, as an EMF line', async () => {
    const { metrics, lines } = recordingEmitter();
    const app = fastify();
    registerResponseTimeMetric(app, metrics);
    app.get('/timed', { config: { operationId: 'listItems' } }, async () => ({ ok: true }));
    app.get('/wait', { config: { operationId: 'waitForPhoneWork' } }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { ready: false };
    });
    app.get('/health', async () => ({ ok: true }));

    await app.inject({ method: 'GET', url: '/timed' });
    await app.inject({ method: 'GET', url: '/wait' });
    await app.inject({ method: 'GET', url: '/health' });
    await app.inject({ method: 'GET', url: '/missing' });
    await app.close();

    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line).toMatchObject({
      service: 'api',
      _aws: {
        CloudWatchMetrics: [
          {
            Namespace: 'Listora',
            Dimensions: [[]],
            Metrics: [{ Name: 'ApiResponseTime', Unit: 'Milliseconds' }],
          },
        ],
      },
    });
    expect(line?.['ApiResponseTime']).toBeGreaterThanOrEqual(0);
    expect(line?.['ApiResponseTime']).toBeLessThan(30);
  });
});
