/**
 * Prices after the facts (docs/features/thrift-scan.md): a scan's prices and its call wait for
 * what they rest on. The household's own sales are checked with the read; the web research (with
 * the brand's pulse) starts the moment the read lands; and each marketplace comparison that is
 * on is read on the seller's iPhone. Until they are all in, or `PRICE_WAIT_MS` passed, the scan
 * says what the item is and holds every price; then it shows the prices from what came back and
 * names what is missing. A missing source is only ever left out of the call, never counted for
 * it, so it can never raise the confidence.
 */
import type { ItemScan, ScanComparison } from '@listora/api-contract';
import type { ThriftScan } from '@listora/analysis';
import { MARKETPLACE_NAMES } from '@listora/marketplaces';

import type { StoredComparison } from './comparisons.ts';
import type { ItemScanRow, ScanCallDetail, StoredResearch } from './repository.ts';
import { researchWanted } from './research.ts';

/**
 * How long the prices wait for a source after the read (the web research from when it
 * started): the web's lookup takes 6 s to 12 s, a marketplace read about 4 s.
 */
export const PRICE_WAIT_MS = 15_000;

export type PricingSource = 'web' | StoredComparison['marketplace'];

export interface MissingSource {
  readonly source: PricingSource;
  /** "Couldn't check the web in time", "Depop prices paused today". */
  readonly label: string;
}

export interface ScanPricing {
  readonly status: 'checking' | 'ready';
  /** The sources still being checked, while `checking`. */
  readonly waitingOn: readonly PricingSource[];
  /** What the prices could not wait for or check, once `ready`. */
  readonly missing: readonly MissingSource[];
  /** What came back: "your sales", "the web", "Depop". */
  readonly checked: readonly string[];
  /** When the prices stop waiting for the sources still out. */
  readonly waitUntil: Date;
}

/** Whether the scan's prices are in, from its row as stored and the time now. */
export function scanPricing(
  row: Pick<
    ItemScanRow,
    'read' | 'research' | 'research_started_at' | 'call_detail' | 'created_at'
  >,
  now: Date,
  waitMs: number = PRICE_WAIT_MS,
): ScanPricing {
  const read = row.read as unknown as ThriftScan;
  const detail = row.call_detail as unknown as ScanCallDetail;
  const research = row.research as unknown as StoredResearch | null;
  const waitingOn: PricingSource[] = [];
  const missing: MissingSource[] = [];
  const checked: string[] = ['your sales'];
  const readAt = row.created_at.getTime();
  let waitUntil = readAt + waitMs;

  if (researchWanted(read)) {
    if (research === null) {
      const deadline = (row.research_started_at?.getTime() ?? readAt) + waitMs;
      waitUntil = Math.max(waitUntil, deadline);
      if (now.getTime() < deadline) waitingOn.push('web');
      else missing.push({ source: 'web', label: "Couldn't check the web in time" });
    } else if (research.status === 'failed') {
      missing.push({ source: 'web', label: "Couldn't check the web" });
    } else {
      checked.push('the web');
    }
  }

  for (const comparison of detail.comparisons ?? []) {
    const name = MARKETPLACE_NAMES[comparison.marketplace];
    switch (comparison.status) {
      case 'checking':
        if (now.getTime() < readAt + waitMs) waitingOn.push(comparison.marketplace);
        else
          missing.push({ source: comparison.marketplace, label: `Couldn't check ${name} in time` });
        break;
      case 'failed':
        missing.push({ source: comparison.marketplace, label: `Couldn't check ${name}` });
        break;
      case 'paused':
        missing.push({
          source: comparison.marketplace,
          label:
            comparison.reason === 'rate_limited'
              ? `${name} prices paused for an hour`
              : `${name} prices paused today`,
        });
        break;
      case 'limit':
        missing.push({
          source: comparison.marketplace,
          label:
            comparison.reason === 'day'
              ? `Not checked: ${name} limit for today`
              : `Not checked: ${name} limit for this hour`,
        });
        break;
      case 'read':
      case 'not_enough':
        // Searched: too few like it is an answer, not a missing source.
        if (comparison.reason !== 'no_query') checked.push(name);
        break;
    }
  }

  return {
    status: waitingOn.length > 0 ? 'checking' : 'ready',
    waitingOn,
    missing: waitingOn.length > 0 ? [] : missing,
    checked,
    waitUntil: new Date(waitUntil),
  };
}

const SOURCE_WORDS = (source: PricingSource): string =>
  source === 'web' ? 'the web' : MARKETPLACE_NAMES[source];

/** "a, b, and c". */
function listed(words: readonly string[]): string {
  if (words.length <= 2) return words.join(' and ');
  return `${words.slice(0, -1).join(', ')}, and ${words.at(-1) ?? ''}`;
}

/**
 * What is missing, in sentences: the sources Listora couldn't check said together ("Couldn't
 * check eBay, Mercari, and Vinted."), as are those it couldn't check in time; the others each
 * in its own.
 */
function missingSentences(missing: readonly MissingSource[]): string[] {
  const groups = new Map<string, string[]>();
  const sentences: (string | { readonly group: string })[] = [];
  for (const source of missing) {
    const match = /^Couldn't check (.+?)( in time)?$/.exec(source.label);
    if (match?.[1] === undefined) {
      sentences.push(`${source.label}.`);
      continue;
    }
    const suffix = match[2] ?? '';
    const names = groups.get(suffix);
    if (names === undefined) {
      groups.set(suffix, [match[1]]);
      sentences.push({ group: suffix });
    } else {
      names.push(match[1]);
    }
  }
  return sentences.map((sentence) =>
    typeof sentence === 'string'
      ? sentence
      : `Couldn't check ${listed(groups.get(sentence.group) ?? [])}${sentence.group}.`,
  );
}

/** The sentences that fit in `max` characters, whole: a sentence that does not fit is left out. */
function withinLength(sentences: readonly string[], max: number): string {
  let label = '';
  for (const sentence of sentences) {
    const next = label === '' ? sentence : `${label} ${sentence}`;
    if (next.length > max) break;
    label = next;
  }
  return label === '' ? (sentences[0] ?? '').slice(0, max) : label;
}

/** The pricing as the API answers it. */
export function pricingView(pricing: ScanPricing): NonNullable<ItemScan['pricing']> {
  if (pricing.status === 'checking') {
    return {
      status: 'checking',
      label: `Checking prices: ${pricing.waitingOn.map(SOURCE_WORDS).join(', ')}`,
      waitingOn: [...pricing.waitingOn],
      waitUntil: pricing.waitUntil.toISOString(),
    };
  }
  const checked = `Checked ${listed(pricing.checked)}.`;
  return {
    status: 'ready',
    label: withinLength([checked, ...missingSentences(pricing.missing)], 120),
    ...(pricing.missing.length === 0
      ? {}
      : { missing: pricing.missing.map((source) => ({ ...source })) }),
    waitUntil: pricing.waitUntil.toISOString(),
  };
}

/**
 * The scan as it shows while its prices wait: what the item is, its flags, and the sales
 * trend, with every price held. The call is `checking`, its confidence the read's, and each
 * comparison keeps what the phone needs to read it but none of its numbers.
 */
export function heldView(view: ItemScan, pricing: ScanPricing): ItemScan {
  // Every price waits: the AI estimate, the retail price, the web's, and the own sales.
  const held: ItemScan = { ...view };
  delete held.aiEstimate;
  delete held.retail;
  delete held.research;
  delete held.realityCheck;
  return {
    ...held,
    ownSales: [],
    ...(view.comparisons === undefined
      ? {}
      : { comparisons: view.comparisons.map(heldComparison) }),
    call: {
      call: 'checking',
      label: 'Checking prices',
      confidence: readConfidence(view.identity.confidence),
      basis: 'none',
      basedOn: pricingView(pricing).label.slice(0, 120),
      worthListing: view.call.worthListing,
      signals: [],
    },
    pricing: pricingView(pricing),
  };
}

/** A comparison with its prices held: what the phone reads, or that it was checked. */
function heldComparison(comparison: ScanComparison): ScanComparison {
  if (comparison.status !== 'read') return comparison;
  return {
    marketplace: comparison.marketplace,
    status: 'read',
    label: `Checked ${MARKETPLACE_NAMES[comparison.marketplace]}`,
    // Counts, not prices: how many are for sale, and whether the read was from the last day.
    ...(comparison.supply === undefined ? {} : { supply: comparison.supply }),
    ...(comparison.cached === undefined ? {} : { cached: comparison.cached }),
  };
}

/** How sure the identification is, in the call's words. */
function readConfidence(confidence: number): 'high' | 'medium' | 'low' {
  return confidence >= 0.8 ? 'high' : confidence >= 0.6 ? 'medium' : 'low';
}
