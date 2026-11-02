/**
 * The scan's web research (docs/features/thrift-scan.md, "Web info"), kept per account so a
 * repeat scan of the same thing is instant and costs no search. One brand makes many models in
 * every category, so an item's facts (its retail price, what it resells for) are reused only
 * for the same exact model (`itemResearchKey`: the model or style number, the item type, the
 * era) for 30 days, and an item whose model the read could not pin is looked up afresh every
 * time. A brand's facts (how well it resells) are kept by the brand alone for 7 days, and so is
 * its pulse on the wider web (`researchBrandPulse`: in demand, steady, or slow), looked up beside
 * the item's facts so it adds no wait, and at most once a week a brand.
 */
import {
  BrandPulseFailedError,
  researchBrandPulse,
  researchScanItem,
  scanResearchSubject,
  type BrandPulse,
  type ScanResearch,
  type ThriftScan,
} from '@listora/analysis';
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
  /** The brand's pulse: kept from before, asked of the web this time, or failed (asked again next time). */
  readonly pulse?: 'kept' | 'asked' | 'failed';
}

type ItemFacts = Omit<ScanResearch, 'reputation' | 'brandPulse'>;

export async function researchFor(
  db: DbExecutor,
  ai: AiClient,
  tenant: Tenant,
  read: ThriftScan,
  now: Date,
): Promise<ResearchResult> {
  const itemKey = itemResearchKey(read);
  const brandKey = brandResearchKey(read.brand);
  const subject = scanResearchSubject(read);
  if (brandKey === undefined || subject === undefined) {
    return { stored: { status: 'no_brand', cached: false }, searches: 0, costMicros: 0 };
  }
  const since = (days: number) => new Date(now.getTime() - days * DAY_MS);
  const item =
    itemKey === undefined
      ? undefined
      : ((await cachedResearch(db, tenant, 'item', itemKey, since(ITEM_RESEARCH_CACHE_DAYS))) as
          ItemFacts | undefined);
  // The brand's pulse runs beside the item's facts, never after them, and never fails them.
  const pulse = brandPulseFor(
    db,
    ai,
    tenant,
    subject.brand,
    brandKey,
    since(BRAND_RESEARCH_CACHE_DAYS),
  );
  if (item !== undefined) {
    const [brand, pulsed] = await Promise.all([
      cachedResearch(db, tenant, 'brand', brandKey, since(BRAND_RESEARCH_CACHE_DAYS)) as Promise<
        Pick<ScanResearch, 'reputation'> | undefined
      >,
      pulse,
    ]);
    const research: ScanResearch = {
      ...item,
      reputation: brand?.reputation ?? 'unknown',
      ...withPulse(pulsed),
    };
    return {
      // `cached` is the item's facts': the pulse says its own in `pulse`.
      stored: { status: statusOf(research), research, cached: true },
      searches: pulsed.searches,
      costMicros: pulsed.costMicros,
      pulse: pulseStatus(pulsed),
    };
  }
  const [outcome, pulsed] = await Promise.all([
    researchScanItem(ai, {
      accountId: tenant.accountId,
      userId: tenant.userId,
      // The fake provider's fixtures key the answer by the exact model, or by the brand and the
      // item's words when the model is not known.
      keyHash: sha256Hex(
        itemKey ?? `${brandKey}|${read.category ?? ''}|${read.item.toLowerCase()}`,
      ),
      ...subject,
    }),
    pulse,
  ]);
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
  const research: ScanResearch = { ...outcome.research, ...withPulse(pulsed) };
  return {
    stored: { status: statusOf(research), research, cached: false },
    searches: outcome.searches + pulsed.searches,
    costMicros: outcome.costMicros + pulsed.costMicros,
    pulse: pulseStatus(pulsed),
  };
}

interface PulseResult {
  /** Undefined when the lookup failed: the card then shows no pulse, and the next scan asks again. */
  readonly pulse: BrandPulse | undefined;
  /** The web was asked this time, rather than the pulse kept from before. */
  readonly asked: boolean;
  readonly searches: number;
  readonly costMicros: number;
}

/**
 * The brand's pulse kept since `since`, or looked up and kept: a pulse that found nothing is
 * kept too, so an obscure brand costs one search a week, not one a scan. A failed lookup is
 * kept nowhere and never fails the research it runs beside; what it cost is still counted.
 */
async function brandPulseFor(
  db: DbExecutor,
  ai: AiClient,
  tenant: Tenant,
  brand: string,
  brandKey: string,
  since: Date,
): Promise<PulseResult> {
  const cached = (await cachedResearch(db, tenant, 'brand_pulse', brandKey, since)) as
    BrandPulse | undefined;
  if (cached !== undefined) return { pulse: cached, asked: false, searches: 0, costMicros: 0 };
  try {
    const outcome = await researchBrandPulse(ai, {
      accountId: tenant.accountId,
      userId: tenant.userId,
      keyHash: sha256Hex(`brand_pulse|${brandKey}`),
      brand,
    });
    await cacheResearch(db, tenant, {
      kind: 'brand_pulse',
      key: brandKey,
      research: outcome.pulse as unknown as JsonObject,
      model: outcome.model,
      costMicros: outcome.costMicros,
    });
    return {
      pulse: outcome.pulse,
      asked: true,
      searches: outcome.searches,
      costMicros: outcome.costMicros,
    };
  } catch (error) {
    if (error instanceof BrandPulseFailedError) {
      return { pulse: undefined, asked: true, searches: 0, costMicros: error.costMicros };
    }
    throw error;
  }
}

/** The pulse to show: only one that says something. */
function withPulse(result: PulseResult): Pick<ScanResearch, 'brandPulse'> {
  return result.pulse === undefined || result.pulse.verdict === 'unknown'
    ? {}
    : { brandPulse: result.pulse };
}

function pulseStatus(result: PulseResult): NonNullable<ResearchResult['pulse']> {
  if (!result.asked) return 'kept';
  return result.pulse === undefined ? 'failed' : 'asked';
}

function statusOf(research: ScanResearch): StoredResearch['status'] {
  return research.retail !== null || research.resale !== null ? 'found' : 'not_found';
}
