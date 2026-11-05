import { describe, expect, it } from 'vitest';

import { buildDepopAutomationPayload, validateDepopAutomationPayload } from '../depop/payload.ts';
import { buildMercariPayload, validateMercariPayload } from '../mercari/payload.ts';
import { buildPoshmarkPayload, validatePoshmarkPayload } from '../poshmark/payload.ts';
import { recordingPlan } from './plans.ts';
import { RECORDED_MARKETPLACES } from './recording.ts';

/**
 * The marketplaces whose seller pages are recorded: every one but Vinted, whose plan has only
 * its public search until its pages are mapped (docs/features/vinted.md, M2).
 */
const SELLER_PAGES = RECORDED_MARKETPLACES.filter(
  (marketplace): marketplace is Exclude<typeof marketplace, 'vinted'> => marketplace !== 'vinted',
);

const validate = {
  depop: (content: Parameters<typeof buildDepopAutomationPayload>) =>
    validateDepopAutomationPayload(buildDepopAutomationPayload(...content)),
  mercari: (content: Parameters<typeof buildMercariPayload>) =>
    validateMercariPayload(buildMercariPayload(...content)),
  poshmark: (content: Parameters<typeof buildPoshmarkPayload>) =>
    validatePoshmarkPayload(buildPoshmarkPayload(...content)),
};

describe('recording plans', () => {
  it.each(SELLER_PAGES)('%s: every form shape is a listing the form takes', (marketplace) => {
    const plan = recordingPlan(marketplace);
    const forms = plan.entries.filter((entry) => entry.mode === 'form');
    expect(forms.length).toBeGreaterThan(8);
    for (const entry of forms) {
      const content = entry.content;
      if (content === undefined) throw new Error(`${entry.name} has no listing`);
      expect(validate[marketplace]([content.item, content.variant]), entry.name).toEqual([]);
    }
  });

  it.each(SELLER_PAGES)(
    '%s: names each entry once, and records every kind of page',
    (marketplace) => {
      const plan = recordingPlan(marketplace);
      const names = plan.entries.map((entry) => entry.name);
      expect(new Set(names).size).toBe(names.length);
      // Offers are recorded where a session has read them (docs/features/offers.md), and the
      // public search where a comparison reader reads it (comps/).
      const pages = new Set(plan.entries.map((entry) => entry.page));
      pages.delete('offers');
      pages.delete('search');
      expect(pages).toEqual(new Set(['hub', 'shop', 'listing', 'edit', 'sell-form', 'sold']));
    },
  );

  it('records only the public search of Vinted, logged out', () => {
    const entries = recordingPlan('vinted').entries;
    expect(entries.map((entry) => [entry.name, entry.page, entry.session])).toEqual([
      ['search', 'search', 'logged_out'],
    ]);
  });

  it('records the public search logged out only, never in the seller session', () => {
    for (const marketplace of RECORDED_MARKETPLACES) {
      for (const entry of recordingPlan(marketplace).entries) {
        expect(entry.page === 'search').toBe(entry.session === 'logged_out');
      }
    }
  });
});
