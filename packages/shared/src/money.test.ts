import { describe, expect, it } from 'vitest';

import { addMoney, money, subtractMoney } from './money.ts';

describe('money', () => {
  it('stores integer cents with a currency', () => {
    expect(money(1999)).toEqual({ amountCents: 1999, currency: 'USD' });
  });

  it.each([19.99, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects %s because it is not safe integer cents',
    (amount) => {
      expect(() => money(amount)).toThrow(RangeError);
    },
  );

  it('adds and subtracts exactly', () => {
    const price = money(1999);
    const fee = money(295);
    expect(addMoney(price, fee)).toEqual(money(2294));
    expect(subtractMoney(price, fee)).toEqual(money(1704));
  });

  it('rejects arithmetic that overflows safe integers', () => {
    expect(() => addMoney(money(Number.MAX_SAFE_INTEGER), money(1))).toThrow(RangeError);
  });

  it('rejects mixing currencies', () => {
    // Only USD exists today; the cast simulates a future second currency.
    const eur = { amountCents: 100, currency: 'EUR' } as unknown as ReturnType<typeof money>;
    expect(() => addMoney(money(100), eur)).toThrow(TypeError);
  });
});
