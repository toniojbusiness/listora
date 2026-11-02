import { describe, expect, it } from 'vitest';

import { THINKING_OFF_BY_MODEL, thinkingOffFor } from './models.ts';
import { PRICE_TABLES } from './prices.ts';

describe('thinkingOffFor', () => {
  it('knows how every priced model turns its thinking off', () => {
    const priced = new Set(PRICE_TABLES.flatMap((table) => Object.keys(table.models)));
    expect(new Set(Object.keys(THINKING_OFF_BY_MODEL))).toEqual(priced);
  });

  it('keeps Haiku on disabled and moves Sonnet to between_tools', () => {
    expect(thinkingOffFor('claude-haiku-5-5')).toBe('disabled');
    expect(thinkingOffFor('claude-sonnet-5-5')).toBe('between_tools');
    expect(thinkingOffFor('claude-opus-5-5')).toBe('unsupported');
  });

  it('sends no setting for a model it does not know', () => {
    expect(thinkingOffFor('claude-next-model')).toBe('unsupported');
  });
});
