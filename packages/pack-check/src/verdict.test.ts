import { describe, expect, it } from 'vitest';

import { describeItem, describeOrder } from './describe.ts';
import { stickerCode, stickerSku } from './sticker.ts';
import { ago, scanVerdict, verdictWords, type ScanFacts, type VerdictOrder } from './verdict.ts';

const tee: VerdictOrder = {
  saleId: 'sale-tee',
  description: 'the black Shaka Wear tee, 2XL',
  skus: ['AJ-000184'],
};
const dress: VerdictOrder = {
  saleId: 'sale-dress',
  description: 'the Free People dress, S',
  skus: ['AJ-000185'],
};
const NOW = new Date('2026-10-27T18:00:00Z');

function facts(overrides: Partial<ScanFacts>): ScanFacts {
  return {
    label: '9400111899223197428490',
    labelUnreadable: false,
    labelIsSticker: false,
    stickerSku: null,
    expected: tee,
    labelOrders: [tee],
    packed: null,
    stickerOrder: null,
    ...overrides,
  };
}

describe('scanVerdict', () => {
  it("is green for the order's own label", () => {
    const verdict = scanVerdict(facts({}));
    expect(verdict).toEqual({ verdict: 'match', order: tee, matchedBy: 'label' });
    expect(verdictWords(verdict, NOW)).toMatchObject({
      tone: 'success',
      headline: 'This label is for the black Shaka Wear tee, 2XL.',
    });
  });

  it('makes the match exact with the item sticker', () => {
    expect(scanVerdict(facts({ stickerSku: 'AJ-000184', stickerOrder: tee }))).toEqual({
      verdict: 'match',
      order: tee,
      matchedBy: 'sticker',
    });
  });

  it("is a red stop for another order's label", () => {
    const verdict = scanVerdict(facts({ labelOrders: [dress] }));
    expect(verdict).toEqual({ verdict: 'wrong_order', order: dress, expected: tee });
    expect(verdictWords(verdict, NOW)).toEqual({
      tone: 'failed',
      headline: 'This label is for the Free People dress, S.',
      detail: 'Do not use it on this package. This package is for the black Shaka Wear tee, 2XL.',
    });
  });

  it("stops a label with another item's sticker", () => {
    const verdict = scanVerdict(facts({ stickerSku: 'AJ-000185', stickerOrder: dress }));
    expect(verdict).toMatchObject({ verdict: 'sticker_mismatch', order: tee, sticker: dress });
    expect(verdictWords(verdict, NOW).headline).toBe(
      'This sticker is for the Free People dress, S.',
    );
  });

  it('catches the double print: a label already on a package, with when and which', () => {
    const packedAt = new Date(NOW.getTime() - 12 * 60_000);
    const verdict = scanVerdict(
      facts({ expected: dress, labelOrders: [tee], packed: { order: tee, packedAt } }),
    );
    expect(verdict).toEqual({
      verdict: 'already_packed',
      packed: { order: tee, packedAt },
      expected: dress,
    });
    expect(verdictWords(verdict, NOW)).toEqual({
      tone: 'failed',
      headline: 'This label was already used.',
      detail:
        'It went on the package for the black Shaka Wear tee, 2XL 12 minutes ago. If your printer printed it twice, throw this copy away.',
    });
  });

  it('says so when the same order is scanned again after packing', () => {
    const verdict = scanVerdict(facts({ packed: { order: tee, packedAt: NOW } }));
    expect(verdictWords(verdict, NOW).headline).toBe(
      'This order is already packed with this label.',
    );
  });

  it("leaves a label Listora doesn't know to the photo check", () => {
    const verdict = scanVerdict(facts({ labelOrders: [] }));
    expect(verdict).toEqual({ verdict: 'unknown_label', expected: tee });
    expect(verdictWords(verdict, NOW).tone).toBe('action_needed');
  });

  it('finds the order of a label with no order chosen', () => {
    expect(scanVerdict(facts({ expected: null, labelOrders: [dress] }))).toEqual({
      verdict: 'found',
      order: dress,
      matchedBy: 'label',
    });
    expect(
      scanVerdict(
        facts({ expected: null, label: null, stickerSku: 'AJ-000185', stickerOrder: dress }),
      ),
    ).toEqual({ verdict: 'found', order: dress, matchedBy: 'sticker' });
  });

  it('tells a sticker and a non-label apart from a label', () => {
    expect(scanVerdict(facts({ label: null, labelIsSticker: true, stickerOrder: tee }))).toEqual({
      verdict: 'sticker_scanned',
      order: tee,
    });
    expect(scanVerdict(facts({ label: null, labelUnreadable: true }))).toEqual({
      verdict: 'not_a_label',
    });
  });
});

describe('describeItem', () => {
  it('names an item by color, brand, kind, and size', () => {
    expect(
      describeItem({
        title: 'Shaka Wear Max Heavyweight Tee',
        sku: 'AJ-000184',
        brand: 'Shaka Wear',
        category: 'clothing/tops/t_shirts',
        sizeLabel: '2XL',
        colors: ['Black'],
      }),
    ).toBe('black Shaka Wear tee, 2XL');
  });

  it('falls back to the title, then the SKU', () => {
    const item = {
      title: 'Vintage lamp',
      sku: 'AJ-000001',
      brand: null,
      category: null,
      sizeLabel: null,
      colors: [],
    };
    expect(describeItem(item)).toBe('Vintage lamp');
    expect(describeItem({ ...item, title: null })).toBe('AJ-000001');
    expect(describeOrder([item, item])).toBe('2 items: Vintage lamp; Vintage lamp');
  });
});

describe('stickers', () => {
  it('round-trips a SKU and refuses other codes', () => {
    expect(stickerCode('AJ-000184')).toBe('LISTORA:AJ-000184');
    expect(stickerSku('LISTORA:AJ-000184')).toBe('AJ-000184');
    expect(stickerSku('aj-000184')).toBe('AJ-000184');
    expect(stickerSku('9400111899223197428490')).toBeNull();
  });
});

describe('ago', () => {
  it('words a time without a time zone', () => {
    expect(ago(NOW, NOW)).toBe('just now');
    expect(ago(new Date(NOW.getTime() - 3 * 3_600_000), NOW)).toBe('3 hours ago');
    expect(ago(new Date(NOW.getTime() - 30 * 3_600_000), NOW)).toBe('yesterday');
  });
});
