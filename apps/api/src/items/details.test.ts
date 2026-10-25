import { describe, expect, it } from 'vitest';

import {
  changedDetails,
  columnsFromDetails,
  detailErrors,
  detailsFromRow,
  isValidGtin,
  normalizeDetails,
  provenanceAfterWrite,
} from './details.ts';

describe('isValidGtin', () => {
  it.each(['036000291452', '4006381333931', '96385074', '00012345600012', '012345678905'])(
    'accepts %s',
    (code) => {
      expect(isValidGtin(code)).toBe(true);
    },
  );

  it.each(['036000291453', '4006381333932', '1234567', '0123456789012345', '03600029145a', ''])(
    'rejects %j',
    (code) => {
      expect(isValidGtin(code)).toBe(false);
    },
  );
});

describe('normalizeDetails', () => {
  it('drops empty values and sorts measurements by name without touching the input', () => {
    const input = {
      title: '',
      colors: [],
      keywords: ['', 'denim'],
      measurements: [
        { name: 'z', value: 1, unit: 'in' as const },
        { name: 'a', value: 2, unit: 'in' as const },
      ],
    };
    expect(normalizeDetails(input)).toEqual({
      keywords: ['denim'],
      measurements: [
        { name: 'a', value: 2, unit: 'in' },
        { name: 'z', value: 1, unit: 'in' },
      ],
    });
    expect(input.measurements[0]?.name).toBe('z');
    expect(normalizeDetails(undefined)).toEqual({});
  });
});

describe('detailErrors', () => {
  it('is empty for valid details', () => {
    expect(
      detailErrors({
        upc: '036000291452',
        listPrice: { amountCents: 100, currency: 'USD' },
        floorPrice: { amountCents: 100, currency: 'USD' },
      }),
    ).toEqual([]);
  });

  it('refuses a list price of zero but allows a cost of zero', () => {
    expect(
      detailErrors({
        listPrice: { amountCents: 0, currency: 'USD' },
        cost: { amountCents: 0, currency: 'USD' },
      }),
    ).toEqual([{ field: 'details.listPrice.amountCents', message: 'must be more than zero' }]);
  });
});

describe('columns and rows', () => {
  it('round-trips every detail through the database columns', () => {
    const details = normalizeDetails({
      title: 'Jacket',
      description: 'Warm',
      brand: 'Acme',
      productName: 'Trail',
      styleNumber: 'ST-1',
      rnNumber: '12345',
      upc: '036000291452',
      department: 'women',
      category: 'clothing/outerwear',
      sizeLabel: 'M',
      sizeSystem: 'us',
      colors: ['red'],
      pattern: 'solid',
      materials: ['wool'],
      condition: 'new_with_tags',
      conditionNotes: 'Never worn',
      flaws: ['loose thread'],
      keywords: ['winter'],
      measurements: [{ name: 'length', value: 26, unit: 'in' }],
      listPrice: { amountCents: 5000, currency: 'USD' },
      floorPrice: { amountCents: 3000, currency: 'USD' },
      cost: { amountCents: 800, currency: 'USD' },
      purchaseDate: '2026-10-01',
      purchaseSource: 'Thrift store',
      quantity: 2,
      storageLocationId: '0190a2b8-0000-7000-8000-000000000001',
      acceptedAnalysisId: '0190a2b8-0000-7000-8000-000000000002',
    });
    const row = { ...rowStub(), ...columnsFromDetails(details) };
    expect(detailsFromRow(row)).toEqual(details);
  });
});

describe('provenanceAfterWrite', () => {
  it('marks new and changed details as the user’s and keeps the source of unchanged ones', () => {
    const before = { brand: 'Acme', title: 'Jacket', quantity: 1 };
    expect(
      provenanceAfterWrite(
        { brand: 'Acme', title: 'Coat', sizeLabel: 'M', quantity: 1 },
        { details: before, provenance: { brand: 'ocr', title: 'ai' } },
      ),
    ).toEqual({ brand: 'ocr', title: 'user', sizeLabel: 'user' });
  });

  it('keeps the source of unchanged money and measurements sent with keys in another order', () => {
    const before = {
      listPrice: { amountCents: 6500, currency: 'USD' as const },
      measurements: [{ name: 'length', value: 26, unit: 'in' as const }],
      quantity: 1,
    };
    expect(
      provenanceAfterWrite(
        {
          listPrice: { currency: 'USD', amountCents: 6500 },
          measurements: [{ name: 'length', unit: 'in', value: 26 }],
          quantity: 1,
        },
        { details: before, provenance: { listPrice: 'ai', measurements: 'ocr' } },
      ),
    ).toEqual({ listPrice: 'ai', measurements: 'ocr' });
  });

  it('gives a default quantity no source, but a quantity the user set stays the user’s', () => {
    expect(provenanceAfterWrite({ quantity: 1 }, undefined)).toEqual({});
    expect(provenanceAfterWrite({ quantity: 3 }, undefined)).toEqual({ quantity: 'user' });
    expect(
      provenanceAfterWrite(
        { quantity: 1 },
        { details: { quantity: 3 }, provenance: { quantity: 'user' } },
      ),
    ).toEqual({ quantity: 'user' });
  });
});

describe('changedDetails', () => {
  it('lists what changed with the sides that exist', () => {
    expect(
      changedDetails(
        { title: 'A', brand: 'B', quantity: 1 },
        { title: 'C', sizeLabel: 'M', quantity: 1 },
      ),
    ).toEqual({
      title: { from: 'A', to: 'C' },
      brand: { from: 'B' },
      sizeLabel: { to: 'M' },
    });
  });
});

function rowStub(): Parameters<typeof detailsFromRow>[0] {
  return {
    id: '0190a2b8-0000-7000-8000-000000000000',
    account_id: '0190a2b8-0000-7000-8000-00000000000a',
    sku: 'AJ-000001',
    status: 'draft',
    attributes: {},
    field_provenance: {},
    version: 1,
    created_at: new Date(),
    updated_at: new Date(),
    pre_archive_status: null,
    ...columnsFromDetails({}),
  };
}
