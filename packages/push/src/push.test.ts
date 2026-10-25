import { describe, expect, it } from 'vitest';

import { createLogger } from '@listora/shared';

import { createPushSender, loadPushConfig, PushConfigError } from './config.ts';
import { parsePushNotification, PUSH_TITLE_MAX_LENGTH } from './notification.ts';
import { deliverPush } from './outbox.ts';
import { RecordingPushSender } from './sender.ts';

const notification = {
  accountId: 'account-1',
  category: 'item_sold',
  title: 'Sold on eBay',
  body: 'Levi jacket sold on eBay.',
  urgency: 'time_sensitive',
  threadId: 'item:1',
  data: { itemId: 'item-1' },
} as const;
const signal = () => AbortSignal.timeout(1_000);
const silent = createLogger({ service: 'push-test', level: 'silent' });

describe('push notifications', () => {
  it('accepts a notification and copies its data', () => {
    expect(parsePushNotification(notification)).toEqual(notification);
    expect(parsePushNotification({ ...notification, threadId: null }).threadId).toBeNull();
  });

  it.each([
    [{ accountId: '' }, 'accountId'],
    [{ category: 'Item Sold' }, 'category'],
    [{ title: '' }, 'title'],
    [{ title: 'x'.repeat(PUSH_TITLE_MAX_LENGTH + 1) }, 'title'],
    [{ body: '' }, 'body'],
    [{ urgency: 'critical' }, 'urgency'],
    [{ threadId: '' }, 'threadId'],
    [{ data: { itemId: 7 } }, 'data'],
    [{ data: { 'item-id': 'x' } }, 'data'],
  ])('refuses %j', (change, field) => {
    expect(() => parsePushNotification({ ...notification, ...change })).toThrow(field);
  });

  it('reads PUSH_DRIVER, which defaults to the fake', () => {
    expect(loadPushConfig({})).toEqual({ driver: 'fake' });
    expect(loadPushConfig({ PUSH_DRIVER: '' })).toEqual({ driver: 'fake' });
    expect(loadPushConfig({ PUSH_DRIVER: 'fake' })).toEqual({ driver: 'fake' });
    expect(() => loadPushConfig({ PUSH_DRIVER: 'apns' })).toThrow(PushConfigError);
    expect(createPushSender({ driver: 'fake' }, silent)).toBeInstanceOf(RecordingPushSender);
  });

  it('delivers a queued notification, and throws while the push service fails', async () => {
    const sender = new RecordingPushSender();
    sender.failNext();
    await expect(deliverPush({ sender, logger: silent }, notification, signal())).rejects.toThrow(
      'unavailable',
    );
    expect(sender.sent).toEqual([]);
    await deliverPush({ sender, logger: silent }, notification, signal());
    expect(sender.sent).toEqual([notification]);
  });

  it('drops a job payload that is not a notification', async () => {
    const sender = new RecordingPushSender();
    const errors: unknown[] = [];
    await deliverPush(
      { sender, logger: { error: (detail: unknown) => errors.push(detail) } },
      { accountId: 'a' },
      signal(),
    );
    expect(sender.sent).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});
