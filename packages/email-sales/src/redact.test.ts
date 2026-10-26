import { describe, expect, it } from 'vitest';

import { readMessage } from './message.ts';
import { EXCERPT_LENGTH, redactedExcerpt } from './redact.ts';
import { fixture } from './test-support.ts';

describe('redactedExcerpt', () => {
  it('keeps what sold and removes the buyer, addresses, links, user names, and long numbers', async () => {
    const message = await readMessage(new TextEncoder().encode(fixture('poshmark-sold')));
    const excerpt = redactedExcerpt(message.text);
    expect(excerpt).toContain("Item: Levi's Vintage Trucker Jacket Size M");
    expect(excerpt).toContain('Price: $45.00');
    expect(excerpt).not.toMatch(/Alex|Main St|62701|janes_closet|poshmark\.com\/listing/);
    expect(excerpt).toContain('Ship to: [removed]');
    expect(excerpt.length).toBeLessThanOrEqual(EXCERPT_LENGTH + 1);
  });

  it('removes email addresses and phone numbers, and cuts long text at a word', () => {
    expect(redactedExcerpt('Contact jane@example.com or +1 (555) 123-4567 today')).toBe(
      'Contact [email] or [number] today',
    );
    const long = redactedExcerpt('word '.repeat(200));
    expect(long.endsWith('…')).toBe(true);
    expect(long.length).toBeLessThanOrEqual(EXCERPT_LENGTH + 1);
  });
});
