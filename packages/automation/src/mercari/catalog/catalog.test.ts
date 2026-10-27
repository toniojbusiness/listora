import { describe, expect, it } from 'vitest';

import { buildMercariCatalog, formatMercariCatalog, type MercariMasterData } from './build.ts';
import { indexCatalog, mercariCatalog } from './catalog.ts';

describe("Mercari's catalog", () => {
  it('holds every department of the sell form, in its dialog order', () => {
    expect(mercariCatalog().departments.map((department) => department.name)).toEqual([
      'Women',
      'Men',
      'Kids',
      'Home',
      'Vintage & collectibles',
      'Beauty',
      'Electronics',
      'Sports & outdoors',
      'Handmade',
      'Other',
      'Arts & Crafts',
      'Books',
      'Pet Supplies',
      'Toys & Collectibles',
      'Garden & Outdoor',
      'Office',
      'Tools',
    ]);
    expect(mercariCatalog().byId.size).toBeGreaterThan(3_000);
  });

  it('gives every sized category a size group with sizes', () => {
    const catalog = mercariCatalog();
    for (const category of catalog.byId.values()) {
      if (category.sizeGroupId === null) continue;
      expect(catalog.sizeLabels(category.sizeGroupId).length, category.path.join(' > ')).toBeGreaterThan(0);
    }
    expect(catalog.find(['Men', 'Tops', 'T-shirts'])).toMatchObject({ id: 303, sizeGroupId: 2 });
    expect(catalog.find(['Women', 'Shoes', 'Boots'])?.sizeGroupId).toBe(5);
    expect(catalog.find(['Home', 'Bedding', 'Quilts'])?.sizeGroupId).toBeNull();
    expect(catalog.find(['Women', 'Moon'])).toBeNull();
  });

  it('lists a size group in the form’s order, standard sizes first, each label once', () => {
    const women = mercariCatalog().sizeLabels(1);
    expect(women.slice(0, 4)).toEqual(['XXS (00)', 'XS (0-2)', 'S (4-6)', 'M (8-10)']);
    expect(new Set(women).size).toBe(women.length);
  });

  it('is built from Mercari’s master data in the dialog’s order, and written a record a line', () => {
    const master: MercariMasterData = {
      itemCategories: [
        { id: 2, name: 'Men', parentId: 0, itemSizeGroupId: 0, displayOrder: 100 },
        { id: 1, name: 'Women', parentId: 0, itemSizeGroupId: 1, displayOrder: 50 },
        { id: 12, name: 'Tops', parentId: 1, itemSizeGroupId: 1, displayOrder: 20 },
        { id: 11, name: 'Dresses', parentId: 1, itemSizeGroupId: 1, displayOrder: 30 },
        { id: 101, name: 'T-shirts', parentId: 12, itemSizeGroupId: 1, displayOrder: 50 },
      ],
      itemSizeGroups: [{ id: 1, title: 'Clothing', category: 'Women', sizeIds: [7, 8], subGroupIds: [10] }],
      itemSizeSubGroups: [{ id: 10, title: 'Standard', sizeIds: [7, 8] }],
      itemSizes: [
        { id: 7, title: 'S', subtitle: '(4-6)' },
        { id: 8, title: 'One Size', subtitle: '' },
      ],
      itemConditions: [{ id: 1, name: 'New' }],
    };
    const file = buildMercariCatalog(master, [101, 101], '2026-10-27');
    expect(file.categories.map((category) => category.name)).toEqual(['Women', 'Men']);
    expect(file.categories[0]?.children?.map((category) => category.name)).toEqual(['Tops', 'Dresses']);
    expect(file.imeiCategoryIds).toEqual([101]);
    expect(file.sizeGroups[0]?.subgroups[0]?.sizes.map((size) => size.label)).toEqual(['S (4-6)', 'One Size']);
    const text = formatMercariCatalog(file);
    expect(text).toContain('\n        {"id": 101, "name": "T-shirts", "sizeGroupId": 1}\n');
    expect(JSON.parse(text)).toEqual(file);
    const indexed = indexCatalog(file);
    expect(indexed.find(['Women', 'Tops', 'T-shirts'])).toMatchObject({ imei: true, hasChildren: false });
    expect(indexed.find(['Women', 'Tops'])?.hasChildren).toBe(true);
  });
});
