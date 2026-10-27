/**
 * Items Depop prohibits, refused before anything is sent, so a listing Depop would remove (and
 * hold against the seller's account) is never posted. From Depop's list of prohibited and
 * restricted items ("What are Depop's prohibited items?", Depop Help Centre, last updated May
 * 2025, read 2026-10-27) and the hashtags its sell form refuses (taxonomy/taxonomy.json):
 *
 * - the hashtags Depop's form refuses;
 * - words that name what Depop's list prohibits in any category: counterfeits, tickets, gift
 *   cards and vouchers, raffles and mystery boxes;
 * - outside clothing and shoes, the items its list names: technology and electronics (phones,
 *   headphones, consoles, laptops, smartwatches, chargers, hair tools), tobacco and vapes,
 *   weapons, drugs, medical products, and the restricted products for babies (car seats,
 *   strollers, cribs). Clothing is left out, where the same words are a print or a brand on a tee
 *   ("PlayStation graphic tee");
 * - used perfume and cosmetics (Depop takes them only unused);
 * - underwear the listing says is unwashed (Depop takes clean, used underwear).
 *
 * The check is a floor, not Depop's review: Depop still decides. A refusal says what was found,
 * so the seller can fix a listing it caught by mistake.
 */
import type { ValidationIssue } from '@listora/marketplaces';

import type { DepopAutomationPayload } from './payload.ts';
import { isBannedDepopHashtag } from './taxonomy/taxonomy.ts';

interface Rule {
  /** What Depop's list calls it, for the message. */
  what: string;
  pattern: RegExp;
}

const word = (words: string) => new RegExp(`\\b(?:${words})\\b`, 'i');

/** Prohibited in every category. */
const EVERYWHERE: readonly Rule[] = [
  { what: 'counterfeit items', pattern: word('counterfeits?|unauthentic|not authentic') },
  { what: 'event tickets', pattern: word('(?:concert|event|festival|game|show) tickets?') },
  { what: 'gift cards and vouchers', pattern: word('gift ?cards?|vouchers?|store credit') },
  { what: 'raffles and mystery boxes', pattern: word('raffles?|mystery (?:box|boxes|bundle)') },
];

/** Prohibited outside clothing and shoes, where the words would name the item itself. */
const OUTSIDE_CLOTHING: readonly Rule[] = [
  {
    what: 'technology and electronics',
    pattern: word(
      'airpods?|earbuds|ear ?phones|headphones|headsets?|bluetooth speakers?|iphones?|smart ?phones?|' +
        'ipads?|tablets?|laptops?|macbooks?|chromebooks?|kindles?|e-?readers?|smart ?watch(?:es)?|apple ?watch|' +
        'fitbits?|fitness trackers?|chargers?|power ?banks?|hard ?drives?|' +
        'playstation|xbox|nintendo switch|game ?consoles?|controllers?|gameboy|' +
        'hair ?(?:dryers?|straighteners?|clippers?)|curling (?:irons?|wands?|tongs?)|' +
        'televisions?|dvd players?',
    ),
  },
  {
    what: 'tobacco and vapes',
    pattern: word(
      'tobacco|cigarettes?|cigars?|vapes?|e-?cigs?|e-?liquids?|juul|nicotine|rolling papers',
    ),
  },
  {
    what: 'weapons',
    pattern: word(
      'firearms?|handguns?|rifles?|ammo|ammunition|knife|knives|switchblades?|swords?|' +
        'brass knuckles|' +
        'airsoft|bb guns?|pepper spray|tasers?|crossbows?',
    ),
  },
  { what: 'drugs', pattern: word('cbd|thc|cannabis|marijuana|weed|bongs?') },
  {
    what: 'medical products',
    pattern: word('contact lenses|medications?|pills?|supplements?|viagra'),
  },
  {
    what: 'restricted products for babies',
    pattern: word(
      'car seats?|strollers?|prams?|pushchairs?|cribs?|bassinets?|baby carriers?|baby slings?|' +
        'infant formula|teethers?',
    ),
  },
  { what: 'alcohol', pattern: word('alcohol|liquor|vodka|whiskey|tequila|bottle of wine') },
];

/** Depop's groups of clothing and shoes, where the outside-clothing words are prints and brands. */
const CLOTHING_GROUPS = new Set([
  'tops',
  'bottoms',
  'dresses',
  'coats-jackets',
  'jumpsuit-and-playsuit',
  'suits',
  'footwear',
  'nightwear',
  'underwear',
  'swim-beach-wear',
  'fancy-dress',
  'sleepsuits-and-bodysuits',
  'bundles',
]);

/** Beauty product types Depop takes only unused (its "restricted perfumes and cosmetics"). */
const UNUSED_ONLY = new Set(['fragrance', 'makeup', 'skincare', 'nails', 'bath-and-body']);

const UNWASHED = word('unwashed|not washed|unclean|worn and not washed');

export function depopProhibitedIssues(payload: DepopAutomationPayload): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const refuse = (field: string, message: string) => {
    issues.push({ field, code: 'prohibited', message });
  };

  const banned = payload.hashtags.filter(isBannedDepopHashtag);
  if (banned.length > 0) {
    refuse(
      'variant.hashtags',
      `Depop doesn't allow the hashtag${banned.length > 1 ? 's' : ''} ${banned.map((tag) => `#${tag}`).join(', ')}.`,
    );
  }

  const [, group, productType] = payload.categoryIds ?? [];
  const text = [payload.description, ...payload.hashtags].join(' ');
  const rules = [
    ...EVERYWHERE,
    ...(group !== undefined && CLOTHING_GROUPS.has(group) ? [] : OUTSIDE_CLOTHING),
  ];
  for (const rule of rules) {
    const found = rule.pattern.exec(text)?.[0];
    if (found !== undefined) {
      refuse(
        'variant.description',
        `Depop doesn't allow ${rule.what} (the listing says "${found}"). If the item isn't one, reword the listing.`,
      );
    }
  }

  if (
    group === 'beauty' &&
    productType !== undefined &&
    UNUSED_ONLY.has(productType) &&
    payload.condition !== null &&
    payload.condition.value !== 'brand_new'
  ) {
    refuse('item.condition', 'Depop allows perfume and cosmetics only unused.');
  }
  if (group === 'underwear') {
    const found = UNWASHED.exec(payload.description)?.[0];
    if (found !== undefined) {
      refuse(
        'variant.description',
        `Depop doesn't allow unwashed underwear (the listing says "${found}").`,
      );
    }
  }
  return issues;
}
