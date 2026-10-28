import { describe, expect, it } from 'vitest';

import { buildDepopAutomationPayload, validateDepopAutomationPayload } from '../depop/payload.ts';
import { buildMercariPayload, validateMercariPayload } from '../mercari/payload.ts';
import { buildPoshmarkPayload, validatePoshmarkPayload } from '../poshmark/payload.ts';
import { recordingPlan } from './plans.ts';
import { RECORDED_MARKETPLACES } from './recording.ts';

const validate = {
  depop: (content: Parameters<typeof buildDepopAutomationPayload>) =>
    validateDepopAutomationPayload(buildDepopAutomationPayload(...content)),
  mercari: (content: Parameters<typeof buildMercariPayload>) =>
    validateMercariPayload(buildMercariPayload(...content)),
  poshmark: (content: Parameters<typeof buildPoshmarkPayload>) =>
    validatePoshmarkPayload(buildPoshmarkPayload(...content)),
};

describe('recording plans', () => {
  it.each(RECORDED_MARKETPLACES)(
    '%s: every form shape is a listing the form takes',
    (marketplace) => {
      const plan = recordingPlan(marketplace);
      const forms = plan.entries.filter((entry) => entry.mode === 'form');
      expect(forms.length).toBeGreaterThan(8);
      for (const entry of forms) {
        const content = entry.content;
        if (content === undefined) throw new Error(`${entry.name} has no listing`);
        expect(validate[marketplace]([content.item, content.variant]), entry.name).toEqual([]);
      }
    },
  );

  it.each(RECORDED_MARKETPLACES)(
    '%s: names each entry once, and records every kind of page',
    (marketplace) => {
      const plan = recordingPlan(marketplace);
      const names = plan.entries.map((entry) => entry.name);
      expect(new Set(names).size).toBe(names.length);
      // Offers are recorded where a session has read them (docs/features/offers.md).
      const pages = new Set(plan.entries.map((entry) => entry.page));
      pages.delete('offers');
      expect(pages).toEqual(new Set(['hub', 'shop', 'listing', 'edit', 'sell-form', 'sold']));
    },
  );
});
