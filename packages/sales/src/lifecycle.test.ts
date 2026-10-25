import { describe, expect, it } from 'vitest';

import { availableSaleActions } from './lifecycle.ts';

describe('the sale lifecycle', () => {
  it('offers each status only the steps that follow it', () => {
    expect(availableSaleActions('detected')).toEqual(['confirm', 'mark_shipped', 'cancel']);
    expect(availableSaleActions('confirmed')).toEqual(['mark_shipped', 'cancel', 'record_return']);
    expect(availableSaleActions('shipped')).toEqual(['record_return']);
    // A canceled or returned sale stays so; what follows is the relist question.
    expect(availableSaleActions('canceled')).toEqual([]);
    expect(availableSaleActions('returned')).toEqual([]);
  });
});
