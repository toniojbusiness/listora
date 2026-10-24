import { knownMarketplaceValues, type KnownMarketplace } from '@listora/api-contract';
import { inTransaction } from '@listora/db';
import {
  buildPricingSuggestion,
  calibrateFees,
  feeTableFor,
  researchQuery,
  type FeeCalibration,
} from '@listora/pricing';
import type { FastifyInstance } from 'fastify';

import { contractRoute, type RouteDependencies } from '../contract/routes.ts';
import { notFound } from '../errors.ts';
import { findItem } from '../items/repository.ts';
import {
  currentAnalysisEstimate,
  currentSnapshots,
  recentObservedSales,
  recordAiEstimate,
} from './repository.ts';

/**
 * `getItemPricing`. Computing a suggestion never calls AI and never uses eBay content; the
 * label guard in `buildPricingSuggestion` runs on every response, and a violation fails the
 * request (a 500) rather than showing a misleading label.
 */
export function registerPricingRoutes(app: FastifyInstance, deps: RouteDependencies): void {
  contractRoute(app, deps, 'getItemPricing', async ({ tenant, db, params, query, request }) =>
    inTransaction(db, async (trx) => {
      const item = await findItem(trx, tenant, params.itemId);
      if (!item) throw notFound('Item');
      const now = new Date();

      const analysis = await currentAnalysisEstimate(trx, tenant, item);
      if (analysis.status === 'found') {
        await recordAiEstimate(trx, tenant, item.id, analysis.payload);
      } else if (analysis.status === 'invalid') {
        request.log.warn(
          { itemId: item.id, analysisId: analysis.analysisId },
          'analysis price estimate is malformed; pricing shows no estimate',
        );
      }
      const snapshots = await currentSnapshots(
        trx,
        tenant,
        item.id,
        analysis.status === 'found' ? analysis.payload.analysisId : undefined,
        now,
      );
      if (snapshots.invalidIds.length > 0) {
        request.log.warn(
          { itemId: item.id, snapshotIds: snapshots.invalidIds },
          'ignored malformed pricing snapshots',
        );
      }

      const marketplaces: readonly KnownMarketplace[] = knownMarketplaceValues;
      const observed = await recentObservedSales(trx, tenant, now);
      const feeCalibrations: Partial<Record<KnownMarketplace, FeeCalibration>> = {};
      for (const marketplace of marketplaces) {
        const calibration = calibrateFees(
          feeTableFor(marketplace, now),
          observed.get(marketplace) ?? [],
        );
        if (calibration) feeCalibrations[marketplace] = calibration;
      }

      const suggestion = buildPricingSuggestion({
        itemId: item.id,
        currency: item.currency,
        costCents: item.cost_cents ?? undefined,
        shippingCents: query.shippingCents ?? 0,
        minimumProfitCents: query.minimumProfitCents ?? 0,
        marketplaces,
        estimate: snapshots.estimate,
        soldData: snapshots.soldData,
        feeCalibrations,
        researchQuery: researchQuery({
          title: item.title ?? undefined,
          brand: item.brand ?? undefined,
          productName: item.product_name ?? undefined,
          styleNumber: item.style_number ?? undefined,
          category: item.category ?? undefined,
        }),
        now,
      });
      return { status: 200, body: suggestion };
    }),
  );
}
