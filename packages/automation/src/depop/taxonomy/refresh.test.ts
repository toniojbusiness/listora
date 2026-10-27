import { describe, expect, it } from 'vitest';

import { buildTaxonomy } from './refresh.ts';

const name = (en: string) => ({ en, 'en-US': en });

/** Depop's answers, cut down to one product type of each kind. */
const RAW = {
  categories: {
    departments: [
      { id: 'menswear', name: 'Men', children: [{ id: 'tops', name: 'Tops' }] },
      { id: 'everything-else', name: 'Everything else', children: [{ id: 'home', name: 'Home' }] },
    ],
    groups: {
      tops: [{ id: 'tshirts', name: 'T-shirts', department: ['menswear'] }],
      home: [
        { id: 'dinnerware', name: 'Dinnerware', department: ['everything-else'] },
        // Depop's form doesn't offer appliances (its prohibited items), so its list hasn't them.
      ],
    },
  },
  attributes: {
    department: [{ id: 'menswear', gender: { is_displayed: false } }],
    group: [
      {
        id: 'tops',
        name_i18n: name('Tops'),
        product_types: [
          { id: 'tshirts', name_i18n: name('T-shirts'), attribute_ids: ['occasion', 'material'] },
        ],
      },
      { id: 'home', name_i18n: name('Home'), product_types: [{ id: 'dinnerware' }] },
    ],
    colour: {
      id: 'colour',
      name_i18n: {},
      max_selection: 2,
      attributes: [
        { id: 'grey', status: 'active', name_i18n: name('Grey') },
        { id: 'teal', status: 'inactive', name_i18n: name('Teal') },
      ],
    },
    generic_attributes: [
      {
        id: 'material',
        name_i18n: name('Material'),
        max_selection: 4,
        attributes: [{ id: 'viscose', name_i18n: name('Viscose ') }],
      },
    ],
  },
  sizes: {
    category_size_mapping: [
      {
        department: 'menswear',
        group: 'tops',
        product_type: 'tshirts',
        size_set_by_region: { US: 54, GB: 52 },
      },
      { department: 'everything-else', group: 'home', product_type: 'dinnerware' },
    ],
    size_sets: [
      {
        id: 54,
        name: 'mens-top-sizes',
        sizes: [{ name_i18n: name('S') }, { name_i18n: name('3XL') }],
      },
      { id: 52, name: 'mens-top-sizes', sizes: [{ name_i18n: name('UK S') }] },
    ],
  },
  bannedHashtags: { banned_hashtags: ['Poshmark', 'poshmark', 'airpods'] },
};

describe('the Depop taxonomy refresh', () => {
  it("builds the snapshot from Depop's own answers: US names and sizes, active values", () => {
    expect(buildTaxonomy(RAW, '2026-10-27')).toEqual({
      source: expect.stringContaining('webapi.depop.com') as unknown,
      fetchedAt: '2026-10-27',
      departments: [
        {
          id: 'menswear',
          name: 'Men',
          asksGender: false,
          groups: [
            {
              id: 'tops',
              name: 'Tops',
              productTypes: [
                {
                  id: 'tshirts',
                  name: 'T-shirts',
                  sizeSet: 54,
                  attributes: ['material', 'occasion'],
                },
              ],
            },
          ],
        },
        {
          id: 'everything-else',
          name: 'Everything else',
          asksGender: false,
          groups: [
            {
              id: 'home',
              name: 'Home',
              productTypes: [
                { id: 'dinnerware', name: 'Dinnerware', sizeSet: null, attributes: [] },
              ],
            },
          ],
        },
      ],
      sizeSets: { '54': { name: 'mens-top-sizes', sizes: ['S', '3XL'] } },
      attributes: {
        colour: { name: 'colour', max: 2, values: [{ id: 'grey', name: 'Grey' }] },
        material: { name: 'Material', max: 4, values: [{ id: 'viscose', name: 'Viscose' }] },
      },
      bannedHashtags: ['airpods', 'poshmark'],
    });
  });

  it('refuses answers that are not what Depop sends', () => {
    expect(() => buildTaxonomy({ ...RAW, sizes: {} }, '2026-10-27')).toThrow();
  });
});
