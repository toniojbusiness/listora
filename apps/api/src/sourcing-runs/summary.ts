/**
 * A sourcing run's summary (docs/features/thrift-scan.md, "Checkout"): its counts, the kept
 * items' estimated resale from their scans' calls, and once checked out its haul and the
 * estimated profit. Every resale number is an estimate from the calls the app showed.
 */
import type { SourcingRunSummary } from '@listora/api-contract';
import type { DbExecutor } from '@listora/db';
import { RUN_PROFIT_LABEL, runEstimate, runProfit, type KeptScanCall } from '@listora/sourcing';

import { findHaul } from '../hauls/repository.ts';
import { loadHaulView } from '../hauls/views.ts';
import { keptScans, type ScanCallDetail } from '../scans/repository.ts';
import type { Tenant } from '../tenancy.ts';
import { runView, type SourcingRunRow } from './repository.ts';

const usd = (amountCents: number) => ({ amountCents, currency: 'USD' as const });

export async function loadRunSummary(
  db: DbExecutor,
  tenant: Tenant,
  run: SourcingRunRow,
): Promise<SourcingRunSummary> {
  const kept = await keptScans(db, tenant, run.id);
  const estimate = runEstimate(
    kept.map((scan): KeptScanCall => {
      const { call } = scan.call_detail as unknown as ScanCallDetail;
      return {
        basis: scan.basis,
        ...(call.low === undefined ? {} : { lowCents: call.low.amountCents }),
        ...(call.high === undefined ? {} : { highCents: call.high.amountCents }),
        ...(call.conservativePayout === undefined
          ? {}
          : { conservativePayoutCents: call.conservativePayout.amountCents }),
        ...(call.optimisticPayout === undefined
          ? {}
          : { optimisticPayoutCents: call.optimisticPayout.amountCents }),
      };
    }),
  );
  const haulRow = run.haul_id === null ? undefined : await findHaul(db, tenant, run.haul_id);
  const haul = haulRow === undefined ? undefined : await loadHaulView(db, tenant, haulRow);
  const profit =
    estimate === undefined || haulRow === undefined
      ? undefined
      : runProfit(estimate, haulRow.total_cents);
  return {
    run: runView(run),
    keptItems: kept.length,
    ...(estimate === undefined
      ? {}
      : {
          estimate: {
            itemCount: estimate.itemCount,
            resaleLow: usd(estimate.resaleLowCents),
            resaleHigh: usd(estimate.resaleHighCents),
            payoutLow: usd(estimate.payoutLowCents),
            payoutHigh: usd(estimate.payoutHighCents),
            basedOn: estimate.basedOn,
            label: estimate.label,
          },
        }),
    ...(haul === undefined ? {} : { haul }),
    ...(profit === undefined
      ? {}
      : {
          profitEstimate: {
            low: usd(profit.lowCents),
            high: usd(profit.highCents),
            label: RUN_PROFIT_LABEL,
          },
        }),
  };
}
