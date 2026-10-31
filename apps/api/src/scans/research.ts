/**
 * The scan's web research (docs/features/thrift-scan.md, "Web info"), kept per account so a
 * repeat scan of the same thing is instant and costs no search. One brand makes many models in
 * every category, so an item's facts (its retail price, what it resells for) are reused only
 * for the same exact model (`itemResearchKey`: the model or style number, the item type, the
 * era) for 30 days, and an item whose model the read could not pin is looked up afresh every
 * time. A brand's facts (how well it resells) are kept by the brand alone for 7 days.
 */
import { researchScanItem, type ScanResearch, type ThriftScan } from '@listora/analysis';
import type { AiClient } from '@listora/ai';
import type { DbExecutor, JsonObject } from '@listora/db';
import { sha256Hex } from '@listora/shared';
import { brandResearchKey, itemResearchKey } from '@listora/sourcing';

import type { Tenant } from '../tenancy.ts';
import { cacheResearch, cachedResearch, type StoredResearch } from './repository.ts';

/** How long an item's web facts, and a brand's, are used again. */
export const ITEM_RESEARCH_CACHE_DAYS = 30;
export const BRAND_RESEARCH_CACHE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ResearchResult {
  readonly stored: StoredResearch;
  /** Searches and cost of this request: none from the cache. */
  readonly searches: number;
  readonly costMicros: number;
}

type ItemFacts = Omit<ScanResearch, 'reputation'>;

export async function researchFor(
  db: DbExecutor,
  ai: AiClient,
  tenant: Tenant,
  read: ThriftScan,
  now: Date,
): Promise<ResearchResult> {
  const itemKey = itemResearchKey(read);
  const brandKey = brandResearchKey(read.brand);
  if (brandKey === undefined || read.brand === null) {
    return { stored: { status: 'no_brand', cached: false }, searches: 0, costMicros: 0 };
  }
  const since = (days: number) => new Date(now.getTime() - days * DAY_MS);
  const item =
    itemKey === undefined
      ? undefined
      : ((await cachedResearch(db, tenant, 'item', itemKey, since(ITEM_RESEARCH_CACHE_DAYS))) as
          ItemFacts | undefined);
  if (item !== undefined) {
    const brand = (await cachedResearch(
      db,
      tenant,
      'brand',
      brandKey,
      since(BRAND_RESEARCH_CACHE_DAYS),
    )) as Pick<ScanResearch, 'reputation'> | undefined;
    const research: ScanResearch = { ...item, reputation: brand?.reputation ?? 'unknown' };
    return {
      stored: { status: statusOf(research), research, cached: true },
      searches: 0,
      costMicros: 0,
    };
  }
  const outcome = await researchScanItem(ai, {
    accountId: tenant.accountId,
    userId: tenant.userId,
    // The fake provider's fixtures key the answer by the exact model, or by the brand and the
    // item's words when the model is not known.
    keyHash: sha256Hex(itemKey ?? `${brandKey}|${read.category ?? ''}|${read.item.toLowerCase()}`),
    brand: read.brand,
    item: read.item,
    ...(read.category === null ? {} : { category: read.category }),
    ...(read.line === null ? {} : { line: read.line }),
    ...(read.styleNumber === null ? {} : { styleNumber: read.styleNumber }),
    ...(read.era === null ? {} : { era: read.era }),
    ...(read.material === null ? {} : { material: read.material }),
    ...(read.style === null ? {} : { style: read.style }),
  });
  const { reputation, ...facts } = outcome.research;
  const spent = { model: outcome.model, costMicros: outcome.costMicros };
  if (itemKey !== undefined) {
    await cacheResearch(db, tenant, {
      kind: 'item',
      key: itemKey,
      research: facts as unknown as JsonObject,
      ...spent,
    });
  }
  if (reputation !== 'unknown') {
    await cacheResearch(db, tenant, {
      kind: 'brand',
      key: brandKey,
      research: { reputation },
      ...spent,
    });
  }
  return {
    stored: { status: statusOf(outcome.research), research: outcome.research, cached: false },
    searches: outcome.searches,
    costMicros: outcome.costMicros,
  };
}

function statusOf(research: ScanResearch): StoredResearch['status'] {
  return research.retail !== null || research.resale !== null ? 'found' : 'not_found';
}
