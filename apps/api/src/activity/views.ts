import type {
  ActivityEntry as ContractEntry,
  SaleExplanation as ContractExplanation,
} from '@listora/api-contract';
import type { ActivityEntry, SaleExplanation } from '@listora/activity';

import { ApiError } from '../errors.ts';

/**
 * The contract's `ActivityEntry` as the seller sees it: absent instead of null, words within
 * their limits, and none of Listora's diagnostics (step timings, error codes, run references).
 */
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
  };
}

export function saleExplanationView(explanation: SaleExplanation): ContractExplanation {
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
