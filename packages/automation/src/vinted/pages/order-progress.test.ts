/**
 * Where a Vinted order stands, from the list it is in and Vinted's words for it (Vinted plan
 * M6): an accepted offer not paid for is no sale, a label to print is still to send, a parcel on
 * its way or delivered has shipped, and a cancel or refund no longer stands. The words are
 * modeled until the mapping records an order in each state.
 */
import { describe, expect, it } from 'vitest';

import { orderProgress, type VintedOrderRecord } from './api.ts';

const order = (status?: string, user?: string): VintedOrderRecord => ({
  transaction_id: '9001',
  date: '2026-11-01T10:00:00Z',
  ...(status === undefined ? {} : { status }),
  ...(user === undefined ? {} : { transaction_user_status: user }),
});

describe('orderProgress', () => {
  it('takes the Completed and Canceled lists at their word', () => {
    expect(orderProgress(order('Parcel delivered'), 'completed')).toBe('completed');
    expect(orderProgress(order('Payment successful'), 'canceled')).toBe('canceled');
  });

  it.each([
    ['Waiting for payment', 'unpaid'],
    ['Offer accepted', 'unpaid'],
    ['Payment pending', 'unpaid'],
    ['Payment successful', 'to_ship'],
    ['Shipping label sent to seller', 'to_ship'],
    ['Waiting for the seller to send the item', 'to_ship'],
    ['Parcel on its way', 'shipped'],
    ['Item sent', 'shipped'],
    ['Parcel delivered', 'shipped'],
    ['Order completed', 'completed'],
    ['Order cancelled', 'canceled'],
    ['Refunded to the buyer', 'canceled'],
    ['Something new on Vinted', 'unknown'],
  ] as const)('reads "%s" in progress as %s', (words, progress) => {
    expect(orderProgress(order(words), 'in_progress')).toBe(progress);
  });

  it('reads the order user status beside its words, and says nothing without either', () => {
    expect(orderProgress(order(undefined, 'failed'), 'in_progress')).toBe('canceled');
    expect(orderProgress(order('Parcel on its way', 'waiting'), 'in_progress')).toBe('shipped');
    expect(orderProgress(order(), 'in_progress')).toBe('unknown');
  });
});
