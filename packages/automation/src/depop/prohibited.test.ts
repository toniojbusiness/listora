import { describe, expect, it } from 'vitest';

import { sampleListingContent } from '@listora/marketplaces/testing';

import { buildDepopAutomationPayload, validateDepopAutomationPayload } from './payload.ts';

/** The issues Depop's rules find in a listing (prohibited ones and every other). */
function issues(overrides: Parameters<typeof sampleListingContent>[0] = {}) {
  const content = sampleListingContent(overrides);
  return validateDepopAutomationPayload(
    buildDepopAutomationPayload(content.item, content.variant),
  ).map((issue) => `${issue.code} ${issue.field}: ${issue.message}`);
}

const prohibited = (overrides: Parameters<typeof sampleListingContent>[0]) =>
  issues(overrides).filter((issue) => issue.startsWith('prohibited'));

describe('Depop prohibited items', () => {
  it('refuses the hashtags Depop refuses', () => {
    expect(prohibited({ variant: { hashtags: ['vintage', 'Poshmark', 'airpods'] } })).toEqual([
      "prohibited variant.hashtags: Depop doesn't allow the hashtags #Poshmark, #airpods.",
    ]);
  });

  it('refuses what Depop prohibits in every category', () => {
    for (const description of [
      'Counterfeit designer jacket, great copy.',
      'Two concert tickets for Saturday.',
      'Comes with a $20 gift card.',
      'Mystery box of five jackets.',
    ]) {
      expect(prohibited({ variant: { description } }), description).toHaveLength(1);
    }
  });

  it('refuses electronics, vapes, and weapons outside clothing, and leaves a print on a tee alone', () => {
    const home = (description: string) =>
      prohibited({
        item: { department: 'women', category: 'home/decor', sizeLabel: null },
        variant: { description },
      });
    expect(home('AirPods Pro, barely used.')).toEqual([
      'prohibited variant.description: Depop doesn\'t allow technology and electronics (the listing says "AirPods"). If the item isn\'t one, reword the listing.',
    ]);
    expect(home('Disposable vape, sealed.')).toHaveLength(1);
    expect(home('Hunting knife with sheath.')).toHaveLength(1);
    expect(home('Hand-painted ceramic vase.')).toEqual([]);
    // On clothing the same words are a print or a brand.
    expect(
      prohibited({
        item: { department: 'men', category: 'clothing/tops/t_shirts', sizeLabel: 'L' },
        variant: { description: 'Vintage PlayStation graphic tee with a controller print.' },
      }),
    ).toEqual([]);
  });

  it('takes perfume and cosmetics only unused', () => {
    const makeup = { categoryRef: 'Everything else > Beauty > Makeup', description: 'Lip set.' };
    expect(
      prohibited({ item: { sizeLabel: null, condition: 'pre_owned_good' }, variant: makeup }),
    ).toEqual(['prohibited item.condition: Depop allows perfume and cosmetics only unused.']);
    expect(
      prohibited({ item: { sizeLabel: null, condition: 'new_with_tags' }, variant: makeup }),
    ).toEqual([]);
  });

  it('takes clean used underwear, and refuses underwear the listing says is unwashed', () => {
    const boxers = (description: string) =>
      prohibited({
        item: { department: 'men', category: 'clothing/intimates/underwear', sizeLabel: 'XL' },
        variant: { description },
      });
    expect(boxers("PSD men's boxer briefs in size XL, washed, pre-owned.")).toEqual([]);
    expect(boxers('Worn twice, unwashed.')).toEqual([
      'prohibited variant.description: Depop doesn\'t allow unwashed underwear (the listing says "unwashed").',
    ]);
  });
});
