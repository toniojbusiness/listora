import { describe, expect, it } from 'vitest';

import {
  browserSessionDetail,
  browserSessionOutcome,
  dollars,
  duration,
  itemChangeTitle,
  operationEventOutcome,
  operationEventSource,
  operationTitle,
  orderDetail,
  saleCheckDetail,
  saleCheckTitle,
  saleDetectionWords,
} from './words.ts';

describe('activity words', () => {
  it('names each marketplace action as the seller would', () => {
    expect(operationTitle('end', 'auto_delist', 'depop')).toBe('Delist on Depop after the sale');
    expect(operationTitle('end', 'user', 'ebay')).toBe('End on eBay');
    expect(operationTitle('price', 'user', 'mercari')).toBe('Change the price on Mercari');
  });

  it('never makes a step look done unless it succeeded, and credits the seller', () => {
    expect(operationEventOutcome('succeeded')).toBe('succeeded');
    expect(operationEventOutcome('verifying')).toBe('in_progress');
    expect(operationEventOutcome('needs_user_action')).toBe('waiting');
    expect(
      operationEventSource({
        from_status: 'needs_user_action',
        to_status: 'succeeded',
        detail: { evidence: 'user_confirmation' },
      }),
    ).toBe('you');
    expect(operationEventSource({ from_status: 'failed', to_status: 'queued', detail: {} })).toBe(
      'you',
    );
    expect(
      operationEventSource({ from_status: 'running', to_status: 'succeeded', detail: {} }),
    ).toBe('listora');
  });

  it('says how a browser session ended: its time and steps, or where and why it stopped', () => {
    const run = { failed_step: null, error_code: null, steps: 4, durationMs: 12_340 };
    expect(browserSessionDetail({ ...run, outcome: 'succeeded' })).toBe(
      'Done in 12.3 s (4 steps).',
    );
    expect(
      browserSessionDetail({
        ...run,
        outcome: 'failed',
        failed_step: 'read the sold items',
        error_code: 'element_missing',
      }),
    ).toBe(
      "Stopped at “read the sold items”: the page wasn't what Listora knows (it may have changed).",
    );
    expect(browserSessionDetail({ ...run, outcome: null })).toBe('Running now.');
    expect(browserSessionOutcome('canceled')).toBe('info');
    expect(browserSessionOutcome('challenge')).toBe('failed');
  });

  it('says what a sale check saw, and that a history read changed nothing', () => {
    const check = {
      host: 'phone' as const,
      orders_seen: 1,
      new_orders: 0,
      error_message: null,
    };
    expect(
      saleCheckTitle({ kind: 'scheduled', outcome: 'succeeded', marketplace: 'mercari' }),
    ).toBe('Checked Mercari for sales');
    expect(saleCheckDetail({ ...check, kind: 'scheduled', outcome: 'succeeded' })).toBe(
      'Saw 1 sold order on your iPhone, none new.',
    );
    expect(saleCheckTitle({ kind: 'history', outcome: 'succeeded', marketplace: 'depop' })).toBe(
      'Read your Depop sold history',
    );
    expect(
      saleCheckDetail({ ...check, kind: 'history', outcome: 'succeeded', orders_seen: 11 }),
    ).toBe('Saw 11 sold orders on your iPhone. Nothing was changed.');
    expect(
      saleCheckDetail({
        ...check,
        kind: 'scheduled',
        outcome: 'failed',
        error_message: "Mercari's sold items page has changed, so Listora couldn't read it.",
      }),
    ).toBe("Mercari's sold items page has changed, so Listora couldn't read it.");
  });

  it('says how Listora learned of a sale', () => {
    expect(saleDetectionWords('poll', 'mercari')).toBe('Listora found it on Mercari.');
    expect(saleDetectionWords('webhook', 'ebay')).toBe('eBay told Listora about it.');
    expect(saleDetectionWords('manual', 'depop')).toBe('You marked it sold.');
    expect(orderDetail('ignored', null)).toContain('none of it is a Listora listing');
  });

  it('words item changes, and anything new from its action name', () => {
    expect(itemChangeTitle('item.sold', { marketplace: 'poshmark' })).toBe('Sold on Poshmark');
    expect(itemChangeTitle('listing.linked', {})).toBe('Linked to an existing listing');
    expect(itemChangeTitle('item.price_tagged', {})).toBe('Item price tagged');
  });

  it('formats money and times', () => {
    expect(dollars(4500)).toBe('$45.00');
    expect(dollars(5)).toBe('$0.05');
    expect(duration(850)).toBe('850 ms');
    expect(duration(12_340)).toBe('12.3 s');
    expect(duration(125_000)).toBe('2 min 5 s');
  });
});
