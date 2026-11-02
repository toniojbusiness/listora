import { createHash } from 'node:crypto';

import type { AiClient } from '@listora/ai';
import {
  researchScanItem,
  ScanResearchFailedError,
  type ScanResearch,
  type ThriftScan,
} from '@listora/analysis';

import type { ScanCallInput } from '@listora/sourcing';

import {
  estimateScores,
  percentile,
  topOf,
  type EstimateScores,
  type ItemResult,
} from './backtest.ts';
import type { ScanDatasetItem } from './dataset.ts';

/**
 * One item's web research (`researchScanItem`, the scan's "Web info"), or why there was none:
 * a read with no brand asks nothing, as at the store (`no_brand`).
 */
export type ResearchRun =
  | {
      readonly ok: true;
      readonly research: ScanResearch;
      readonly costMicros: number;
      readonly latencyMs: number;
      readonly searches: number;
    }
  | {
      readonly ok: false;
      readonly message: string;
      readonly costMicros: number;
      readonly latencyMs: number;
    }
  | { readonly ok: false; readonly skipped: 'no_brand' };

/** Looks an item up on the web the way the scan does once its card has been on screen. */
export interface ScanResearcher {
  readonly id: string;
  readonly description: string;
  research(item: ScanDatasetItem, scan: ThriftScan): Promise<ResearchRun>;
}

/** The research key's hash for an item of the set: what the fake provider's fixtures key by. */
export function researchKeyHash(item: ScanDatasetItem): string {
  return createHash('sha256').update(`scan-backtest|${item.id}`).digest('hex');
}

export interface AiScanResearcherOptions {
  readonly id: string;
  readonly description: string;
  readonly client: AiClient;
  readonly now?: () => number;
}

/**
 * The production web research (`researchScanItem` from @listora/analysis) on the scan's read:
 * the same prompt, searches, page verification, retry, and metering as at the store.
 */
export class AiScanResearcher implements ScanResearcher {
  readonly id: string;
  readonly description: string;
  readonly #client: AiClient;
  readonly #now: () => number;

  constructor(options: AiScanResearcherOptions) {
    this.id = options.id;
    this.description = options.description;
    this.#client = options.client;
    this.#now = options.now ?? (() => performance.now());
  }

  async research(item: ScanDatasetItem, scan: ThriftScan): Promise<ResearchRun> {
    if (scan.brand === null) return { ok: false, skipped: 'no_brand' };
    const started = this.#now();
    try {
      const outcome = await researchScanItem(this.#client, {
        accountId: 'eval',
        userId: null,
        keyHash: researchKeyHash(item),
        brand: scan.brand,
        item: scan.item,
        ...optional('category', scan.category),
        ...optional('line', scan.line),
        ...optional('styleNumber', scan.styleNumber),
        ...optional('era', scan.era),
        ...optional('material', scan.material),
        ...optional('style', scan.style),
      });
      return {
        ok: true,
        research: outcome.research,
        costMicros: outcome.costMicros,
        latencyMs: this.#now() - started,
        searches: outcome.searches,
      };
    } catch (error) {
      if (error instanceof ScanResearchFailedError) {
        return {
          ok: false,
          message: error.message,
          costMicros: error.costMicros,
          latencyMs: this.#now() - started,
        };
      }
      throw error;
    }
  }
}

function optional<K extends string>(
  key: K,
  value: string | null | undefined,
): Partial<Record<K, string>> {
  return value === null || value === undefined || value === ''
    ? {}
    : ({ [key]: value } as Record<K, string>);
}

/**
 * The research's part of the call's input, as the API's `assessScan` builds it: the retail
 * price off the tag first, else the web's, and what the web says such items resell for.
 */
export function researchCallInput(
  scan: ThriftScan,
  run: ResearchRun | undefined,
): Pick<ScanCallInput, 'retail' | 'web'> {
  const research = run?.ok === true ? run.research : undefined;
  const web = research?.retail;
  const retail: ScanCallInput['retail'] =
    scan.retailPriceCents !== null
      ? { lowCents: scan.retailPriceCents, highCents: scan.retailPriceCents, from: 'tag' }
      : web === undefined || web === null
        ? undefined
        : {
            lowCents: web.lowCents,
            highCents: web.highCents,
            from: 'web',
            site: web.sources[0]?.site,
            models: web.models,
          };
  const resale = research?.resale;
  return {
    ...(retail === undefined ? {} : { retail }),
    ...(resale === undefined || resale === null || research === undefined
      ? {}
      : {
          web: {
            lowCents: resale.lowCents,
            highCents: resale.highCents,
            sites: resale.sources.map((source) => source.site),
            reputation: research.reputation,
          },
        }),
  };
}

/**
 * The expected resale range the research gives, as the card shows it, for scoring against
 * what the item really sold for: what the web says such items resell for, its middle the
 * midpoint.
 */
export function researchRange(
  research: ScanResearch,
): { lowCents: number; midCents: number; highCents: number } | undefined {
  const resale = research.resale;
  if (resale === null) return undefined;
  return {
    lowCents: resale.lowCents,
    midCents: Math.round((resale.lowCents + resale.highCents) / 2),
    highCents: resale.highCents,
  };
}

/** How the web research did, overall and by the items' labeled top category. */
export interface ResearchScores {
  readonly overall: ResearchGroupScores;
  readonly byCategory: readonly ResearchGroupScores[];
  readonly costMicrosTotal: number;
  readonly costMicrosPerLookup: number;
  readonly searchesPerLookup: number | null;
  readonly latencyP50Ms: number | null;
}

export interface ResearchGroupScores {
  /** "all", a labeled top category ("clothing/tops"), or "unlabeled". */
  readonly group: string;
  readonly items: number;
  /** Items looked up (the read named a brand), and lookups that failed. */
  readonly lookedUp: number;
  readonly failed: number;
  readonly retailFound: number;
  /** Lookups that gave an expected resale range. */
  readonly rangeFound: number;
  /** Lookups whose range's middle is above the retail price found. */
  readonly aboveRetail: number;
  /** The expected resale range against the sale price. */
  readonly estimate: EstimateScores;
}

export function researchScores(
  items: readonly ScanDatasetItem[],
  results: readonly ItemResult[],
): ResearchScores {
  const byId = new Map(items.map((item) => [item.id, item]));
  const groupOf = (id: string) => {
    const category = byId.get(id)?.category ?? null;
    return category === null ? 'unlabeled' : topOf(category);
  };
  const groups = [...new Set(results.map((result) => groupOf(result.id)))].sort();
  let costMicrosTotal = 0;
  let searches = 0;
  let lookups = 0;
  const latencies: number[] = [];
  for (const result of results) {
    const run = result.research;
    if (run === undefined || 'skipped' in run) continue;
    lookups += 1;
    costMicrosTotal += run.costMicros;
    latencies.push(run.latencyMs);
    if (run.ok) searches += run.searches;
  }
  return {
    overall: groupScores('all', results),
    byCategory: groups.map((group) =>
      groupScores(
        group,
        results.filter((result) => groupOf(result.id) === group),
      ),
    ),
    costMicrosTotal,
    costMicrosPerLookup: lookups === 0 ? 0 : Math.round(costMicrosTotal / lookups),
    searchesPerLookup: lookups === 0 ? null : searches / lookups,
    latencyP50Ms: percentile(latencies, 0.5),
  };
}

function groupScores(group: string, results: readonly ItemResult[]): ResearchGroupScores {
  let lookedUp = 0;
  let failed = 0;
  let retailFound = 0;
  let aboveRetail = 0;
  const ranges: {
    range: { lowCents: number; midCents: number; highCents: number };
    saleCents: number;
  }[] = [];
  for (const result of results) {
    const run = result.research;
    if (run === undefined || 'skipped' in run) continue;
    lookedUp += 1;
    if (!run.ok) {
      failed += 1;
      continue;
    }
    const retail = run.research.retail;
    if (retail !== null) retailFound += 1;
    const range = researchRange(run.research);
    if (range === undefined) continue;
    ranges.push({ range, saleCents: result.salePriceCents });
    if (retail !== null && range.midCents > retail.highCents) aboveRetail += 1;
  }
  return {
    group,
    items: results.length,
    lookedUp,
    failed,
    retailFound,
    rangeFound: ranges.length,
    aboveRetail,
    estimate: estimateScores(ranges),
  };
}
