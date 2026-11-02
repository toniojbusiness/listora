/**
 * The wait for a scan's prices (docs/features/thrift-scan.md, "Prices after the facts"): the
 * app asks once, and the answer comes the moment the web research and every comparison are in,
 * or when the prices' wait ends (`scanPricing`), instead of the app asking again on a timer. A
 * change this process saved wakes the wait at once (`ScanResearchRunner.changes`); one another
 * API task saved is seen within `LOOK_MS`.
 */
import type { DbExecutor, KeyedSignals } from '@listora/db';

import type { Tenant } from '../tenancy.ts';
import { scanPricing } from './pricing.ts';
import { findScan, type ItemScanRow } from './repository.ts';

/** How often a wait looks at the scan when nothing in this process woke it. */
export const LOOK_MS = 500;

/**
 * The scan once its prices are in, its wait is over, or `signal` aborted; undefined when it
 * no longer exists.
 */
export async function waitForPrices(
  db: DbExecutor,
  changes: KeyedSignals,
  tenant: Tenant,
  scanId: string,
  options: { now: () => Date; waitMs: number; signal?: AbortSignal },
): Promise<ItemScanRow | undefined> {
  for (;;) {
    // Subscribed before the scan is read, so a change committed in between is heard.
    const subscription = changes.subscribe(scanId);
    try {
      const row = await findScan(db, tenant, scanId);
      if (row === undefined) return undefined;
      const pricing = scanPricing(row, options.now(), options.waitMs);
      if (pricing.status === 'ready') return row;
      const remaining = pricing.waitUntil.getTime() - options.now().getTime();
      // One look past the wait's end makes the prices show from what came back.
      const wake = await subscription.wait(
        Math.min(Math.max(remaining, 0) + 1, LOOK_MS),
        options.signal,
      );
      if (wake === 'aborted') return row;
    } finally {
      subscription.cancel();
    }
  }
}
