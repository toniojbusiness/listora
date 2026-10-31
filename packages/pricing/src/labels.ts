/**
 * The label guard. The words "sold" and "comps" appear only next to real sold data
 * (`REAL_SOLD_DATA_SOURCES`), never next to an AI estimate or a cost floor. Every suggestion
 * the API returns passes `labelGuardViolations` first, and a violation fails the request
 * instead of showing a misleading label.
 */
import type { ItemScan, PricingSuggestion } from '@listora/api-contract';

import { RESEARCH_LINK_LABELS } from './research-links.ts';
import { isRealSoldDataSource, SOLD_DATA_LISTING_CONTEXT } from './sources.ts';

export const AI_ESTIMATE_LABEL = 'AI estimate - not based on sold listings';
/** Shown with whatever the thrift scan's web research found: web pages, never sales. */
export const WEB_INFO_LABEL = 'Web info - not sold listings';
/**
 * Shown with what similar listings for sale ask on a marketplace (the thrift scan's
 * comparisons): asking prices, never what anything sold for.
 */
export const ASKING_PRICES_LABEL = 'Asking prices - not sold listings';
export const NO_SOLD_DATA_MESSAGE = 'No sold data available for this item';
/**
 * What starts every text about sold listings in a marketplace's public search (the thrift scan's
 * eBay comparisons): real sold listings, but other sellers', never the household's own sales.
 */
export const MARKET_SOLD_LABEL_PREFIX = 'Sold listings on ';

/** Shown with what similar listings sold for on a marketplace: "Sold listings on eBay". */
export function marketSoldLabel(marketplace: string): string {
  return `${MARKET_SOLD_LABEL_PREFIX}${marketplace}`;
}

/** Words that claim sold data, anywhere in a label. */
const SOLD_DATA_WORDS = /\b(sold|comps?|comparables?)\b/i;

/** Whether `text` claims to describe sold data. */
export function claimsSoldData(text: string): boolean {
  return SOLD_DATA_WORDS.test(text);
}

/**
 * Every way `suggestion` breaks the label rules, as readable messages (empty when it is
 * honest):
 * - sold comparables come only from real sold data sources, and a source bound to one
 *   listing context (`SOLD_DATA_LISTING_CONTEXT`) names that marketplace;
 * - without them, the suggestion carries `NO_SOLD_DATA_MESSAGE`, and with them it does not;
 * - the AI estimate is always labeled `AI_ESTIMATE_LABEL`;
 * - a tier is based on sold data only when there is sold data, and only such a tier's label
 *   may mention it;
 * - every other text in the suggestion, present or added later, never mentions sold data.
 *   The fixed messages above say there is none, and research links (only the builder's) name
 *   the outside page the user opens, so those are exempt.
 */
export function labelGuardViolations(suggestion: PricingSuggestion): string[] {
  const violations: string[] = [];
  const comparables = suggestion.soldComparables ?? [];
  for (const [index, comparable] of comparables.entries()) {
    if (!isRealSoldDataSource(comparable.source)) {
      violations.push(`soldComparables[${String(index)}] has source ${String(comparable.source)}`);
      continue;
    }
    const context = SOLD_DATA_LISTING_CONTEXT[comparable.source];
    if (context !== undefined && comparable.marketplace !== context) {
      violations.push(
        `soldComparables[${String(index)}] (${comparable.source}) has marketplace ` +
          `${String(comparable.marketplace)} instead of ${context}`,
      );
    }
  }

  if (comparables.length === 0) {
    if (suggestion.noSoldDataMessage !== NO_SOLD_DATA_MESSAGE) {
      violations.push('noSoldDataMessage is missing although there is no sold data');
    }
  } else if (suggestion.noSoldDataMessage !== undefined) {
    violations.push('noSoldDataMessage is present although there is sold data');
  }

  if (suggestion.aiEstimate && suggestion.aiEstimate.label !== AI_ESTIMATE_LABEL) {
    violations.push(`aiEstimate.label is "${suggestion.aiEstimate.label}"`);
  }

  for (const [index, tier] of suggestion.tiers.entries()) {
    if (tier.basis === 'sold_data') {
      if (comparables.length === 0) {
        violations.push(`tiers[${String(index)}] is based on sold data that is not there`);
      }
    } else if (claimsSoldData(tier.label)) {
      violations.push(`tiers[${String(index)}] (${tier.basis}) is labeled "${tier.label}"`);
    }
  }

  for (const [index, link] of suggestion.researchLinks.entries()) {
    if (!RESEARCH_LINK_LABELS.has(link.label)) {
      violations.push(`researchLinks[${String(index)}] is labeled "${link.label}"`);
    }
  }

  const exempt = new Set<unknown>([
    ...comparables,
    suggestion.aiEstimate,
    ...suggestion.researchLinks,
    ...suggestion.tiers.filter((tier) => tier.basis === 'sold_data'),
  ]);
  for (const { path, text } of strings(suggestion, '', exempt)) {
    if (path === 'noSoldDataMessage' && text === NO_SOLD_DATA_MESSAGE) continue;
    if (claimsSoldData(text)) violations.push(`${path} mentions sold data: "${text}"`);
  }
  return violations;
}

/**
 * Every way a thrift scan's answer breaks the label rules (docs/features/thrift-scan.md), like
 * `labelGuardViolations`: the AI estimate is always labeled `AI_ESTIMATE_LABEL`, research
 * links carry only the builder's labels, and nothing but real sold data mentions sold data, the
 * call's wording included: the seller's own sales, and a marketplace's sold listings (a
 * comparison with `sold`, always under `marketSoldLabel`, and every other word about them,
 * which starts with it; a call resting on them needs such a comparison). What the AI read the item as (its identity and search words) names the
 * item, not a price source, so it is exempt.
 */
export function scanLabelViolations(scan: ItemScan): string[] {
  const violations: string[] = [];
  if (scan.aiEstimate && scan.aiEstimate.label !== AI_ESTIMATE_LABEL) {
    violations.push(`aiEstimate.label is "${scan.aiEstimate.label}"`);
  }
  for (const [index, link] of scan.researchLinks.entries()) {
    if (!RESEARCH_LINK_LABELS.has(link.label)) {
      violations.push(`researchLinks[${String(index)}] is labeled "${link.label}"`);
    }
  }
  if (scan.call.basis === 'ai_estimate' && scan.call.basedOn !== AI_ESTIMATE_LABEL) {
    violations.push(`call.basedOn is "${scan.call.basedOn}" for an AI estimate`);
  }
  if (scan.call.basis === 'web_info' && !scan.call.basedOn.startsWith(WEB_INFO_LABEL)) {
    violations.push(`call.basedOn is "${scan.call.basedOn}" for web info`);
  }
  if (scan.research && scan.research.label !== WEB_INFO_LABEL) {
    violations.push(`research.label is "${scan.research.label}"`);
  }
  const soldComparisons = (scan.comparisons ?? []).filter(
    (comparison) => comparison.sold !== undefined,
  );
  for (const [index, comparison] of (scan.comparisons ?? []).entries()) {
    if (comparison.asking && comparison.asking.label !== ASKING_PRICES_LABEL) {
      violations.push(`comparisons[${String(index)}].asking.label is "${comparison.asking.label}"`);
    }
    if (comparison.sold && !comparison.sold.label.startsWith(MARKET_SOLD_LABEL_PREFIX)) {
      violations.push(`comparisons[${String(index)}].sold.label is "${comparison.sold.label}"`);
    }
  }
  // A call on a marketplace's sold listings says so, and only a comparison's sold ones back it.
  if (
    scan.call.basis === 'market_sold' &&
    (soldComparisons.length === 0 || !scan.call.basedOn.startsWith(MARKET_SOLD_LABEL_PREFIX))
  ) {
    violations.push(`call.basedOn is "${scan.call.basedOn}" for a marketplace's sold listings`);
  }
  if (scan.research?.summary !== undefined && claimsSoldData(scan.research.summary)) {
    violations.push(`research.summary mentions sold data: "${scan.research.summary}"`);
  }
  const exempt = new Set<unknown>([
    scan.identity,
    scan.aiEstimate,
    scan.research,
    ...scan.ownSales,
    ...scan.researchLinks,
    ...soldComparisons,
  ]);
  for (const { path, text } of strings(scan, '', exempt)) {
    if (path === 'searchWords') continue;
    // The honest labels themselves name sold listings to say they are not any.
    if (
      text.startsWith(AI_ESTIMATE_LABEL) ||
      text.startsWith(WEB_INFO_LABEL) ||
      text.startsWith(ASKING_PRICES_LABEL) ||
      text.startsWith(MARKET_SOLD_LABEL_PREFIX)
    ) {
      continue;
    }
    if (claimsSoldData(text)) violations.push(`${path} mentions sold data: "${text}"`);
  }
  return violations;
}

/** Every string in `value` with its path, skipping the objects in `exempt`. */
function* strings(
  value: unknown,
  path: string,
  exempt: ReadonlySet<unknown>,
): Generator<{ path: string; text: string }> {
  if (typeof value === 'string') {
    yield { path, text: value };
    return;
  }
  if (typeof value !== 'object' || value === null || exempt.has(value)) return;
  const entries = Array.isArray(value)
    ? value.map((entry, index) => [`${path}[${String(index)}]`, entry] as const)
    : Object.entries(value).map(
        ([key, entry]) => [path === '' ? key : `${path}.${key}`, entry] as const,
      );
  for (const [childPath, child] of entries) yield* strings(child, childPath, exempt);
}
