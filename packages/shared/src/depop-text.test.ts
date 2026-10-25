import { describe, expect, it } from 'vitest';

import {
  DEPOP_EMAIL_ADDRESS,
  depopDescription,
  endsWithHashtagLine,
  splitDepopDescription,
} from './depop-text.ts';

describe('Depop listing text', () => {
  it('puts the hashtags on their own line after the copy', () => {
    expect(depopDescription('Faded denim.', ['vintage', 'denim'])).toBe(
      'Faded denim.\n\n#vintage #denim',
    );
    expect(depopDescription('Faded denim.', [])).toBe('Faded denim.');
  });

  it('reads the copy and hashtags back out of a description', () => {
    for (const [copy, hashtags] of [
      ['Faded denim.\n\nFits true to size.', ['vintage', 'y2k']],
      ['One line', []],
      ['Mentions #summer inline.', ['beach']],
      ['', ['empty']],
    ] as const) {
      expect(splitDepopDescription(depopDescription(copy, hashtags))).toEqual({
        description: copy,
        hashtags,
      });
    }
  });

  it('keeps a last paragraph that is not only hashtags as copy', () => {
    expect(splitDepopDescription('Copy\n\n#vintage and more')).toEqual({
      description: 'Copy\n\n#vintage and more',
      hashtags: [],
    });
    expect(splitDepopDescription('#vintage #denim')).toEqual({
      description: '#vintage #denim',
      hashtags: [],
    });
  });

  it('tells copy that would read back as hashtags', () => {
    expect(endsWithHashtagLine('Copy\n\n#vintage')).toBe(true);
    expect(endsWithHashtagLine('Copy #vintage')).toBe(false);
  });

  it('spots email addresses', () => {
    expect(DEPOP_EMAIL_ADDRESS.test('write to me@example.com')).toBe(true);
    expect(DEPOP_EMAIL_ADDRESS.test('size M @ 22in')).toBe(false);
  });
});
