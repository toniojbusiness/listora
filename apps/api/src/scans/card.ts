/**
 * The scan card's reality check (docs/features/thrift-scan.md, "The card"): what the prices
 * rest on, in short plain lines a seller reads at a glance, like a friend who checked: their own
 * sales like it, sold listings elsewhere, what listings ask now, the original retail price, the
 * brand's pulse, what the item likely costs where the household sources, and any source that
 * could not be checked. Every line is made from the scan's own data; "sold" appears only on the
 * household's own sales and a marketplace's sold listings (the label guard,
 * `scanLabelViolations`, holds it).
 */
import type { ItemScan, ScanRealityLine } from '@listora/api-contract';
import type { BrandPulse } from '@listora/analysis';
import { MARKET_SOLD_LABEL_PREFIX } from '@listora/pricing';
import { soldPace } from '@listora/sourcing';

import type { ScanPricing } from './pricing.ts';

const MAX_LINE = 160;

const PULSE_WORDS = { in_demand: 'in demand', steady: 'steady', slow: 'slow' } as const;

/** The card's reality check, from the scan as it shows once its prices are in. */
export function realityCheck(
  view: ItemScan,
  pulse: BrandPulse | undefined,
  pricing: ScanPricing,
): ScanRealityLine[] {
  const lines: ScanRealityLine[] = [];
  for (const own of view.ownSales) {
    const count = own.soldCount === 1 ? '1 like it' : `${String(own.soldCount)} like it`;
    lines.push({
      kind: 'own_sales',
      text: `You sold ${count} on ${marketplaceName(own.marketplace)}: ${range(own.low, own.high)}, most around ${dollars(own.median)}${
        own.displayOnly ? ' (shown, not used for the price)' : ''
      }`,
    });
  }
  for (const comparison of view.comparisons ?? []) {
    const name = marketplaceName(comparison.marketplace);
    const { sold, asking } = comparison;
    if (sold !== undefined) {
      lines.push({
        kind: 'market_sold',
        text: `${MARKET_SOLD_LABEL_PREFIX}${name}: ${range(sold.low, sold.high)}, ${soldPace(sold.count, sold.windowDays ?? null)}`,
      });
    }
    if (asking !== undefined) {
      lines.push({
        kind: 'asking',
        text: `${name} asks ${range(asking.low, asking.high)} now, ${String(asking.count)} like it for sale (asks, not sales)`,
      });
    }
  }
  const resale = view.research?.resale;
  if (resale !== undefined) {
    const sites = resale.sources.map((source) => source.site).join(', ');
    lines.push({
      kind: 'web',
      text: `Listings on the web ask ${range(resale.low, resale.high)}${sites === '' ? '' : ` (${sites})`}`,
    });
  }
  if (view.retail !== undefined) {
    const where =
      view.retail.source === 'tag'
        ? ''
        : view.retail.site === undefined
          ? ''
          : ` (${view.retail.site})`;
    lines.push({ kind: 'retail', text: `${view.retail.label}${where}` });
  }
  if (pulse !== undefined && pulse.verdict !== 'unknown') {
    const brand = view.identity.brand ?? 'The brand';
    lines.push({
      kind: 'brand_pulse',
      text: `${brand} is ${PULSE_WORDS[pulse.verdict]} on the web: ${pulse.reason.replace(/[.]$/, '')}`,
    });
  }
  const cost = view.call.sourcing;
  if (cost !== undefined) {
    lines.push({ kind: 'cost', text: `${cost.label}: ${lowerFirst(cost.basedOn)}` });
  }
  for (const source of pricing.missing) lines.push({ kind: 'missing', text: source.label });
  return lines.slice(0, 10).map((line) => ({ ...line, text: clip(line.text) }));
}

/** A line held to the card's length, cut at a word with an ellipsis. */
function clip(text: string): string {
  if (text.length <= MAX_LINE) return text;
  const cut = text.slice(0, MAX_LINE - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > MAX_LINE / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, '')}…`;
}

type Money = ItemScan['ownSales'][number]['low'];

function dollars(money: Money): string {
  return `$${String(Math.round(money.amountCents / 100))}`;
}

function range(low: Money, high: Money): string {
  const from = dollars(low);
  const to = dollars(high);
  return from === to ? from : `${from}-${to}`;
}

function marketplaceName(marketplace: ItemScan['ownSales'][number]['marketplace']): string {
  switch (marketplace) {
    case 'ebay':
      return 'eBay';
    case 'depop':
      return 'Depop';
    case 'poshmark':
      return 'Poshmark';
    case 'mercari':
      return 'Mercari';
    default:
      return marketplace;
  }
}

/** "about 0.75 lb ...": a basedOn as the second half of a line. */
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
