import { describe, expect, it } from 'vitest';

import {
  ADDRESS_TOKEN_LENGTH,
  forwardingAddress,
  newAddressToken,
  tokenOfRecipient,
} from './address.ts';

describe('forwarding addresses', () => {
  it('makes random 20-character base32 tokens', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => newAddressToken()));
    expect(tokens.size).toBe(200);
    for (const token of tokens)
      expect(token).toMatch(new RegExp(`^[a-z2-7]{${String(ADDRESS_TOKEN_LENGTH)}}$`));
  });

  it('reads the token back from a recipient at the inbound domain only', () => {
    const token = newAddressToken();
    const address = forwardingAddress(token, 'in.listora.test');
    expect(address).toBe(`sales+${token}@in.listora.test`);
    expect(tokenOfRecipient(address, 'in.listora.test')).toBe(token);
    expect(tokenOfRecipient(`Listora <${address.toUpperCase()}>`, 'in.listora.test')).toBe(token);
    expect(tokenOfRecipient(address, 'in.example.com')).toBeUndefined();
    expect(tokenOfRecipient(`other+${token}@in.listora.test`, 'in.listora.test')).toBeUndefined();
    expect(tokenOfRecipient('sales+short@in.listora.test', 'in.listora.test')).toBeUndefined();
    expect(
      tokenOfRecipient(`sales+${token}@evil.in.listora.test`, 'in.listora.test'),
    ).toBeUndefined();
  });
});
