import { describe, expect, it } from 'vitest';

import { stepLabel } from './progress.ts';

describe('stepLabel', () => {
  it('says what a step does as it happens', () => {
    expect(stepLabel('add the photos')).toBe('Adding the photos');
    expect(stepLabel('choose the category')).toBe('Choosing the category');
    expect(stepLabel('post')).toBe('Posting');
    expect(stepLabel('fill in the title and description')).toBe(
      'Filling in the title and description',
    );
    expect(stepLabel('set the SKU and availability')).toBe('Setting the SKU and availability');
    expect(stepLabel('get the photos')).toBe('Getting the photos');
    expect(stepLabel('read closet page 2')).toBe('Reading closet page 2');
    expect(stepLabel('find Delete listing')).toBe('Finding Delete listing');
  });

  it('leaves a name that does not start with a word as it is', () => {
    expect(stepLabel('2FA')).toBe('2FA');
  });
});
