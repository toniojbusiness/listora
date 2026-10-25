import { describe, expect, it } from 'vitest';

import { parsePushNotification } from '@listora/push';

import {
  doubleSaleNotification,
  escalationNotification,
  itemLabel,
  reminderNotification,
  soldNotification,
} from './messages.ts';
import type { DelistResult } from './results.ts';

const context = {
  accountId: 'account-1',
  itemId: 'item-1',
  saleId: 'sale-1',
  delistRunId: 'run-1',
  label: "Levi's trucker jacket",
  soldOn: 'ebay',
} as const;

const result = (marketplace: DelistResult['marketplace'], state: DelistResult['state']) =>
  ({ marketplace, state }) as DelistResult;

describe('auto-delist notifications', () => {
  it('names the item by its title, or its SKU', () => {
    expect(itemLabel({ title: '  Jacket ', sku: 'AJ-000184' })).toBe('Jacket');
    expect(itemLabel({ title: null, sku: 'AJ-000184' })).toBe('AJ-000184');
    expect(itemLabel({ title: 'x'.repeat(80), sku: 'AJ-000184' })).toHaveLength(60);
  });

  it('says after the sale what Listora delists and what the seller has to', () => {
    const sold = soldNotification(context, { listora: ['depop'], seller: ['poshmark', 'mercari'] });
    expect(parsePushNotification(sold)).toEqual(sold);
    expect(sold).toEqual({
      accountId: 'account-1',
      category: 'item_sold',
      title: 'Sold on eBay',
      body: "Levi's trucker jacket sold on eBay. Listora is delisting it on Depop. Delist it on Poshmark and Mercari now.",
      urgency: 'time_sensitive',
      threadId: 'item:item-1',
      data: { itemId: 'item-1', saleId: 'sale-1', delistRunId: 'run-1' },
    });
  });

  it('re-alerts and escalates with what is still open', () => {
    const open = [
      result('poshmark', 'needs_user_action'),
      result('depop', 'failed'),
      result('mercari', 'verifying'),
    ];
    expect(reminderNotification(context, open)).toMatchObject({
      category: 'delist_reminder',
      title: "Still listed: Levi's trucker jacket",
      body: 'It sold on eBay 10 minutes ago. Delist it on Poshmark now. Delisting failed on Depop; open Listora to retry. Listora is still delisting it on Mercari.',
    });
    expect(escalationNotification(context, open)).toMatchObject({
      category: 'delist_escalation',
      title: "Double-sale risk: Levi's trucker jacket",
      body: expect.stringContaining(
        'It sold on eBay 30 minutes ago and is still listed on Poshmark, Depop, and Mercari.',
      ) as string,
    });
  });

  it('tells the seller to cancel one order of a double sale', () => {
    const notification = doubleSaleNotification({
      ...context,
      soldOn: 'depop',
      earlierSoldOn: 'ebay',
      taskId: 'task-1',
    });
    expect(notification).toMatchObject({
      category: 'double_sale',
      title: "Double sale: Levi's trucker jacket",
      body: 'It sold on Depop after it sold on eBay. Cancel one of the orders; Listora has the steps.',
      data: { itemId: 'item-1', saleId: 'sale-1', taskId: 'task-1' },
    });
    expect(
      doubleSaleNotification({ ...context, earlierSoldOn: 'ebay', taskId: 'task-1' }).body,
    ).toBe('It sold again on eBay. Cancel one of the orders; Listora has the steps.');
  });
});
