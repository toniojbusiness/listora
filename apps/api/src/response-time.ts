/**
 * The API's response time as a metric (`ApiResponseTime`, @listora/observability), which the
 * `api-latency-p95` alarm reads (docs/features/alerts.md). One value per answered contract
 * operation, from the request's arrival to its response, except the long polls: each of those
 * waits by design, up to its own limit, for something to happen (the phone's next work, an
 * item's change, a scan's prices), so its time says nothing about how fast the API is. The
 * gateway's and the load balancer's own latency metrics count them with the rest, and the
 * phone's 20-second wait alone kept the alarm firing (the personal environment, 17 times in the
 * week to 2026-11-08). Health checks, webhooks, and other routes outside the contract's secured
 * operations are left out too: they are not the app's calls.
 */
import type { FastifyInstance } from 'fastify';

import type { MetricsEmitter } from '@listora/observability';

import type { OperationId } from './contract/routes.ts';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Set by `contractRoute`: the contract operation the route serves. */
    operationId?: OperationId;
  }
}

/** The contract's long polls: operations that answer when something happens or their wait ends. */
export const LONG_POLL_OPERATIONS: ReadonlySet<OperationId> = new Set<OperationId>([
  // The phone app's wait for its next work (up to `waitSeconds`, 20).
  'waitForPhoneWork',
  // The item screen's wait for a change to the item (up to `waitSeconds`, 20).
  'waitForItemChange',
  // A scan's wait for its prices (up to `PRICE_WAIT_MS`, 15 s).
  'researchScan',
]);

/** Whether a response of `operationId` counts toward the API's response time. */
export function isTimedOperation(operationId: OperationId | undefined): boolean {
  return operationId !== undefined && !LONG_POLL_OPERATIONS.has(operationId);
}

/** Emits `ApiResponseTime` for each response of a timed operation. */
export function registerResponseTimeMetric(app: FastifyInstance, metrics: MetricsEmitter): void {
  app.addHook('onResponse', async (_request, reply) => {
    if (!isTimedOperation(reply.routeOptions.config.operationId)) return;
    metrics.emit([
      {
        timestamp: new Date(),
        dimensions: {},
        values: { ApiResponseTime: [Math.round(reply.elapsedTime)] },
      },
    ]);
  });
}
