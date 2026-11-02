import type { ItemScan } from '@listora/api-contract';
import { describe, expect, it } from 'vitest';

import { realityCheck } from './card.ts';
import { heldView, PRICE_WAIT_MS, pricingView, scanPricing } from './pricing.ts';

// An invented read and its stored call; no real shop's data.
const READ = {
  brand: 'Wrenfield',
  item: 'wool overcoat',
  line: null,
  styleNumber: null,
  era: null,
  material: 'wool',
  category: 'clothing/outerwear/coats',
  department: 'men',
  sizeLabel: 'L',
  condition: 'pre_owned_good',
  identityConfidence: 0.85,
  aiEstimate: { lowCents: 3000, midCents: 4000, highCents: 5000 },
  retailPriceCents: null,
  style: null,
  searchWords: 'wrenfield wool overcoat',
  flags: { visibleDamage: false, lotOrBundle: false, counterfeitProne: false },
};
const READ_AT = new Date('2026-11-02T12:00:00.000Z');
const after = (ms: number) => new Date(READ_AT.getTime() + ms);

function row(
  overrides: {
    read?: Record<string, unknown>;
    research?: Record<string, unknown> | null;
    startedAt?: Date | null;
    comparisons?: Record<string, unknown>[];
  } = {},
) {
  return {
    read: { ...READ, ...overrides.read },
    research: overrides.research ?? null,
    research_started_at: overrides.startedAt === undefined ? READ_AT : overrides.startedAt,
    call_detail: {
      call: {},
      ownSales: [],
      ...(overrides.comparisons === undefined ? {} : { comparisons: overrides.comparisons }),
    },
    created_at: READ_AT,
  } as unknown as Parameters<typeof scanPricing>[0];
}

describe('scanPricing', () => {
  it('waits for the web and every comparison still being read', () => {
    const pricing = scanPricing(
      row({
        comparisons: [
          { marketplace: 'depop', status: 'checking' },
          { marketplace: 'ebay', status: 'read' },
        ],
      }),
      after(2_000),
    );
    expect(pricing).toMatchObject({ status: 'checking', waitingOn: ['web', 'depop'], missing: [] });
    expect(pricing.waitUntil).toEqual(after(PRICE_WAIT_MS));
    expect(pricingView(pricing)).toEqual({
      status: 'checking',
      label: 'Checking prices: the web, Depop',
      waitingOn: ['web', 'depop'],
      waitUntil: after(PRICE_WAIT_MS).toISOString(),
    });
  });

  it('is ready once all are in, saying what was checked', () => {
    const pricing = scanPricing(
      row({
        research: { status: 'found', cached: false },
        comparisons: [
          { marketplace: 'depop', status: 'read' },
          { marketplace: 'mercari', status: 'not_enough', reason: 'no_match' },
        ],
      }),
      after(6_000),
    );
    expect(pricing.status).toBe('ready');
    expect(pricingView(pricing)).toMatchObject({
      status: 'ready',
      label: 'Checked your sales, the web, Depop, and Mercari.',
    });
  });

  it('stops waiting at the cap, naming each source still out', () => {
    const pricing = scanPricing(
      row({ comparisons: [{ marketplace: 'depop', status: 'checking' }] }),
      after(PRICE_WAIT_MS),
    );
    expect(pricing).toMatchObject({
      status: 'ready',
      waitingOn: [],
      missing: [
        { source: 'web', label: "Couldn't check the web in time" },
        { source: 'depop', label: "Couldn't check Depop in time" },
      ],
    });
    expect(pricingView(pricing).label).toBe(
      "Checked your sales. Couldn't check the web in time. Couldn't check Depop in time.",
    );
  });

  it('counts the web from when its lookup started, so a lookup asked again gets its own wait', () => {
    const late = scanPricing(row({ startedAt: after(60_000) }), after(70_000));
    expect(late).toMatchObject({ status: 'checking', waitingOn: ['web'] });
    expect(late.waitUntil).toEqual(after(60_000 + PRICE_WAIT_MS));
  });

  it('names a failed lookup and every comparison with no numbers, and waits for none of them', () => {
    const pricing = scanPricing(
      row({
        research: { status: 'failed', cached: false },
        comparisons: [
          { marketplace: 'depop', status: 'paused', reason: 'check' },
          { marketplace: 'ebay', status: 'limit', reason: 'hour' },
          { marketplace: 'mercari', status: 'failed' },
        ],
      }),
      after(1_000),
    );
    expect(pricing.status).toBe('ready');
    expect(pricing.missing.map((source) => source.label)).toEqual([
      "Couldn't check the web",
      'Depop prices paused today',
      'Not checked: eBay limit for this hour',
      "Couldn't check Mercari",
    ]);
  });

  it('needs nothing for a read without a brand, and no search counts as checked', () => {
    const pricing = scanPricing(
      row({
        read: { brand: null },
        startedAt: null,
        comparisons: [{ marketplace: 'depop', status: 'not_enough', reason: 'no_query' }],
      }),
      after(10),
    );
    expect(pricing).toMatchObject({ status: 'ready', missing: [], checked: ['your sales'] });
  });
});

describe('heldView', () => {
  const view: ItemScan = {
    id: '01a19e11-0000-7000-8000-000000000001',
    runId: '01a19e11-0000-7000-8000-000000000002',
    createdAt: READ_AT.toISOString(),
    identity: { item: 'wool overcoat', brand: 'Wrenfield', confidence: 0.85 },
    aiEstimate: {
      label: 'AI estimate - not based on sold listings',
      low: { amountCents: 2300, currency: 'USD' },
      mid: { amountCents: 3000, currency: 'USD' },
      high: { amountCents: 3800, currency: 'USD' },
    },
    flags: { visibleDamage: true, lotOrBundle: false, counterfeitProne: false },
    retail: {
      low: { amountCents: 19_800, currency: 'USD' },
      high: { amountCents: 19_800, currency: 'USD' },
      source: 'tag',
      label: 'Retail $198 on the tag',
    },
    ownSales: [
      {
        marketplace: 'depop',
        label: 'Your Wrenfield sales on Depop (last 365 days)',
        soldCount: 3,
        low: { amountCents: 3000, currency: 'USD' },
        median: { amountCents: 3500, currency: 'USD' },
        high: { amountCents: 4000, currency: 'USD' },
        displayOnly: false,
      },
    ],
    comparisons: [
      {
        marketplace: 'depop',
        status: 'read',
        label: 'Depop: asking $40-$60, 6 like it for sale',
        asking: {
          count: 6,
          low: { amountCents: 4000, currency: 'USD' },
          median: { amountCents: 5000, currency: 'USD' },
          high: { amountCents: 6000, currency: 'USD' },
          label: 'Asking prices - not sold listings',
        },
        supply: 40,
        cached: false,
      },
      {
        marketplace: 'ebay',
        status: 'checking',
        label: 'Checking eBay...',
        read: { id: '01a19e11-0000-7000-8000-000000000003', input: { version: 1 } },
      },
    ],
    call: {
      call: 'buy',
      label: 'Grab',
      why: 'Even its low end pays out $26 after fees, over your $8',
      confidence: 'medium',
      basis: 'own_history',
      basedOn: 'Your 3 sales like it',
      low: { amountCents: 3000, currency: 'USD' },
      high: { amountCents: 4000, currency: 'USD' },
      worthListing: { amountCents: 800, currency: 'USD' },
      signals: [{ kind: 'style', label: 'Gorpcore', basedOn: "The AI's read of the style" }],
    },
    searchWords: 'wrenfield wool overcoat',
    researchLinks: [],
    decision: 'undecided',
  };

  it('says what the item is and holds every price and the call', () => {
    const pricing = scanPricing(
      row({ comparisons: [{ marketplace: 'ebay', status: 'checking' }] }),
      after(1_000),
    );
    const held = heldView(view, pricing);
    expect(held.identity).toEqual(view.identity);
    expect(held.flags).toEqual(view.flags);
    expect(held.aiEstimate).toBeUndefined();
    expect(held.retail).toBeUndefined();
    expect(held.ownSales).toEqual([]);
    expect(held.call).toEqual({
      call: 'checking',
      label: 'Checking prices',
      confidence: 'high',
      basis: 'none',
      basedOn: 'Checking prices: the web, eBay',
      worthListing: { amountCents: 800, currency: 'USD' },
      signals: [],
    });
    // Depop's read keeps its count but none of its prices; eBay's read is still handed out.
    expect(held.comparisons).toEqual([
      { marketplace: 'depop', status: 'read', label: 'Checked Depop', supply: 40, cached: false },
      view.comparisons?.[1],
    ]);
    expect(JSON.stringify(held)).not.toMatch(/amountCents":(?!800)/);
  });

  it('gives the reality check from verified data only, plainly', () => {
    const pricing = scanPricing(
      row({
        research: { status: 'failed', cached: false },
        comparisons: [{ marketplace: 'ebay', status: 'failed' }],
      }),
      after(1_000),
    );
    expect(
      realityCheck(
        view,
        {
          verdict: 'in_demand',
          reason: 'Collectors seek its 1990s coats.',
          premium: null,
          sources: [],
        },
        pricing,
      ),
    ).toEqual([
      { kind: 'own_sales', text: 'You sold 3 like it on Depop: $30-$40, most around $35' },
      {
        kind: 'asking',
        text: 'Depop asks $40-$60 now, 6 like it for sale (asks, not sales)',
      },
      { kind: 'retail', text: 'Retail $198 on the tag' },
      {
        kind: 'brand_pulse',
        text: 'Wrenfield is in demand on the web: Collectors seek its 1990s coats',
      },
      { kind: 'missing', text: "Couldn't check the web" },
      { kind: 'missing', text: "Couldn't check eBay" },
    ]);
  });
});
