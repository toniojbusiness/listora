import { AiCallError, AiGuardError } from '@listora/ai';
import { describe, expect, it } from 'vitest';

import {
  decodeScanAnswer,
  MAX_SCAN_ATTEMPTS,
  SCAN_OUTPUT,
  SCAN_OUTPUT_NAME,
  SCAN_PURPOSE,
  SCAN_SYSTEM,
  ScanFailedError,
  scanItem,
  scanPrompt,
  type ScanAnswer,
  type ScanInput,
} from './scan.ts';
import { AI_ESTIMATE_LABEL } from './result.ts';
import { ACCOUNT, client, image } from './test-support.ts';

const HASH = 'b'.repeat(64);

function input(overrides: Partial<ScanInput> = {}): ScanInput {
  return {
    accountId: ACCOUNT,
    userId: null,
    photoSetHash: HASH,
    images: [image('item shot', 1024, 768)],
    ...overrides,
  };
}

function answer(overrides: Partial<ScanAnswer> = {}): ScanAnswer {
  return {
    brand: 'Patagonia',
    item: 'green Synchilla fleece pullover',
    line: 'Synchilla',
    styleNumber: '',
    era: '',
    material: 'fleece',
    category: 'clothing/outerwear/jackets',
    department: 'unisex',
    sizeLabel: 'M',
    condition: 'pre_owned_good',
    identityConfidence: 0.9,
    priceEstimate: { lowCents: 3_500, midCents: 4_500, highCents: 6_000 },
    retailPriceCents: 0,
    style: 'gorpcore',
    searchWords: 'patagonia synchilla fleece',
    flags: { visibleDamage: false, lotOrBundle: false, counterfeitProne: false },
    ...overrides,
  };
}

const fixture = (value: unknown) => ({ outputs: { [SCAN_OUTPUT_NAME]: value } });

async function rejection(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
}

describe('scanItem', () => {
  it('reads the identity, the labeled estimate, and the flags in one metered call', async () => {
    const { ai, usageStore } = client({ hash: HASH, fixture: fixture(answer()) });
    const outcome = await scanItem(ai, input({ note: '  Patagonia, medium  ' }));
    expect(outcome.scan).toEqual({
      brand: 'Patagonia',
      item: 'green Synchilla fleece pullover',
      line: 'Synchilla',
      styleNumber: null,
      era: null,
      material: 'fleece',
      category: 'clothing/outerwear/jackets',
      department: 'unisex',
      sizeLabel: 'M',
      condition: 'pre_owned_good',
      identityConfidence: 0.9,
      aiEstimate: { lowCents: 3_500, midCents: 4_500, highCents: 6_000 },
      retailPriceCents: null,
      style: 'gorpcore',
      searchWords: 'patagonia synchilla fleece',
      flags: { visibleDamage: false, lotOrBundle: false, counterfeitProne: false },
    });
    expect(outcome).toMatchObject({ model: 'claude-haiku-5-5', attempts: 1 });
    expect(outcome.costMicros).toBeGreaterThan(0);
    expect(usageStore.events).toMatchObject([
      { purpose: SCAN_PURPOSE, tier: 'standard', outcome: 'succeeded', images: 1 },
    ]);
  });

  it('turns what the AI could not tell into nulls, and an all-zero price into none', () => {
    const scan = decodeScanAnswer(
      answer({
        brand: '',
        category: '',
        department: '',
        sizeLabel: '',
        condition: '',
        priceEstimate: { lowCents: 0, midCents: 0, highCents: 0 },
        style: '',
      }),
    );
    expect(decodeScanAnswer(answer({ retailPriceCents: 6_800 })).retailPriceCents).toBe(6_800);
    expect(scan).toMatchObject({
      style: null,
      retailPriceCents: null,
      brand: null,
      category: null,
      department: null,
      sizeLabel: null,
      condition: null,
      aiEstimate: null,
    });
  });

  it('rejects a price out of order and a category outside the vocabulary', () => {
    const parse = (value: ScanAnswer) => SCAN_OUTPUT.schema.safeParse(value).success;
    expect(parse(answer())).toBe(true);
    expect(parse(answer({ priceEstimate: { lowCents: 500, midCents: 400, highCents: 900 } }))).toBe(
      false,
    );
    expect(parse(answer({ category: 'clothing/tops/capes' }))).toBe(false);
  });

  it('sends a bad answer once more, then fails with the cost of both attempts', async () => {
    const { ai, usageStore } = client({ hash: HASH, fixture: fixture({ brand: 'only a brand' }) });
    const error = await rejection(scanItem(ai, input()));
    expect(error).toBeInstanceOf(ScanFailedError);
    expect((error as ScanFailedError).attempts).toBe(MAX_SCAN_ATTEMPTS);
    expect((error as ScanFailedError).costMicros).toBeGreaterThan(0);
    expect((error as ScanFailedError).cause).toBeInstanceOf(AiCallError);
    expect(usageStore.events).toHaveLength(MAX_SCAN_ATTEMPTS);
  });

  it('stops at a tripped guard without calling or billing anything', async () => {
    const { ai, usageStore } = client({ hash: HASH, fixture: fixture(answer()), killSwitch: true });
    const error = await rejection(scanItem(ai, input()));
    expect((error as ScanFailedError).cause).toBeInstanceOf(AiGuardError);
    expect((error as ScanFailedError).costMicros).toBe(0);
    expect(usageStore.events).toHaveLength(0);
  });

  it('takes one or two images', async () => {
    const { ai } = client({ hash: HASH, fixture: fixture(answer()) });
    await expect(scanItem(ai, input({ images: [] }))).rejects.toThrow(RangeError);
    const three = [image('a'), image('b'), image('c')];
    await expect(scanItem(ai, input({ images: three }))).rejects.toThrow(RangeError);
  });
});

describe('the scan request', () => {
  it('says which image is which and carries the note and tag text only when there are any', () => {
    expect(JSON.parse(scanPrompt(input()))).toEqual({ images: ['item'] });
    expect(
      JSON.parse(
        scanPrompt(
          input({
            images: [image('item'), image('tag')],
            note: 'small stain',
            tagText: ['PATAGONIA', 'M'],
          }),
        ),
      ),
    ).toEqual({
      images: ['item', 'tag_close_up'],
      note: 'small stain',
      tagText: ['PATAGONIA', 'M'],
    });
  });

  it('tells the model its estimate is shown as an AI estimate', () => {
    expect(SCAN_SYSTEM).toContain(`"${AI_ESTIMATE_LABEL}"`);
  });
});
