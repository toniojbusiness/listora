import type {
  ActivityEntry as ContractEntry,
  SaleExplanation as ContractExplanation,
} from '@listora/api-contract';
import type { ActivityEntry, SaleExplanation } from '@listora/activity';

import { ApiError } from '../errors.ts';

/** The contract's `ActivityEntry`: absent instead of null, words within their limits. */
export function activityEntryView(entry: ActivityEntry): ContractEntry {
  return {
    id: entry.id,
    at: entry.at.toISOString(),
    kind: entry.kind,
    source: entry.source,
    outcome: entry.outcome,
    ...(entry.marketplace === null ? {} : { marketplace: entry.marketplace }),
    title: entry.title.slice(0, 300),
    ...(entry.detail === null ? {} : { detail: entry.detail.slice(0, 1000) }),
    ...(entry.itemId === null ? {} : { itemId: entry.itemId }),
    ...(entry.listingId === null ? {} : { listingId: entry.listingId }),
    ...(entry.operationId === null ? {} : { operationId: entry.operationId }),
    ...(entry.saleId === null ? {} : { saleId: entry.saleId }),
    ...(entry.durationMs === null ? {} : { durationMs: Math.max(0, entry.durationMs) }),
    ...(entry.steps === null || entry.steps.length === 0
      ? {}
      : {
          steps: entry.steps.slice(0, 100).map((step) => ({
            name: step.name.slice(0, 100),
            ...(step.durationMs === null ? {} : { durationMs: step.durationMs }),
          })),
        }),
    ...(entry.error === null
      ? {}
      : {
          error: {
            code: entry.error.code.slice(0, 100),
            message: entry.error.message.slice(0, 1000),
          },
        }),
    ...(entry.reference === null
      ? {}
      : {
          reference: {
            ...(entry.reference.runId === null ? {} : { runId: entry.reference.runId }),
            ...(entry.reference.saleCheckId === null
              ? {}
              : { saleCheckId: entry.reference.saleCheckId }),
            screenshot: entry.reference.screenshot,
          },
        }),
  };
}

export function saleExplanationView(explanation: SaleExplanation): ContractExplanation {
  const { check } = explanation;
  return {
    saleId: explanation.saleId,
    marketplace: explanation.marketplace,
    ...(explanation.externalOrderId === null
      ? {}
      : { externalOrderId: explanation.externalOrderId }),
    soldAt: explanation.soldAt.toISOString(),
    recordedAt: explanation.recordedAt.toISOString(),
    detectionSource: explanation.detectionSource,
    detection: explanation.detection,
    ...(check === null
      ? {}
      : {
          check: {
            id: check.id,
            kind: check.kind,
            host: check.host,
            startedAt: check.startedAt.toISOString(),
            ...(check.finishedAt === null ? {} : { finishedAt: check.finishedAt.toISOString() }),
            ...(check.ordersSeen === null ? {} : { ordersSeen: check.ordersSeen }),
            ...(check.newOrders === null ? {} : { newOrders: check.newOrders }),
            ...(check.runId === null ? {} : { runId: check.runId }),
          },
        }),
    ...(explanation.reportedAt === null
      ? {}
      : { reportedAt: explanation.reportedAt.toISOString() }),
    delists: explanation.delists.map((delist) => ({
      itemId: delist.itemId,
      marketplace: delist.marketplace,
      ...(delist.listingId === null ? {} : { listingId: delist.listingId }),
      ...(delist.operationId === null ? {} : { operationId: delist.operationId }),
      ...(delist.taskId === null ? {} : { taskId: delist.taskId }),
      status: delist.status,
      result: delist.result.slice(0, 1000),
      ...(delist.attempts === null ? {} : { attempts: delist.attempts }),
      ...(delist.error === null
        ? {}
        : {
            error: {
              code: delist.error.code.slice(0, 100),
              message: delist.error.message.slice(0, 1000),
            },
          }),
      startedAt: delist.startedAt.toISOString(),
      ...(delist.settledAt === null ? {} : { settledAt: delist.settledAt.toISOString() }),
    })),
    entries: explanation.entries.map(activityEntryView),
  };
}

const CURSOR_VERSION = 't1';

/** A page cursor: the time of the page's last (oldest) entry; the next page is older. */
export function encodeActivityCursor(at: Date): string {
  return Buffer.from(`${CURSOR_VERSION}:${String(at.getTime())}`).toString('base64url');
}

/** The time a cursor continues before; `400 invalid_request` for one this server did not issue. */
export function decodeActivityCursor(cursor: string): Date {
  const [version, ms] = Buffer.from(cursor, 'base64url').toString('utf8').split(':');
  const time = Number(ms);
  if (version !== CURSOR_VERSION || ms === undefined || !/^\d{1,15}$/.test(ms)) {
    throw new ApiError(
      'invalid_request',
      'The page cursor is not valid. Start from the first page.',
    );
  }
  return new Date(time);
}
