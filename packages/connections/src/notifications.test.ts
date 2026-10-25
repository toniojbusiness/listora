import { parsePushNotification, PUSH_BODY_MAX_LENGTH } from '@listora/push';
import { describe, expect, it } from 'vitest';

import { connectionBrokenNotification } from './notifications.ts';

const broken = {
  connectionId: '0199a1f0-0000-7000-8000-00000000c001',
  accountId: '0199a1f0-0000-7000-8000-00000000a001',
  marketplace: 'depop' as const,
};

describe('connectionBrokenNotification', () => {
  it("asks to reconnect the marketplace, in the problem's own words, and opens Marketplaces", () => {
    expect(
      connectionBrokenNotification({ ...broken, message: "Listora's Depop access expired." }),
    ).toEqual({
      accountId: broken.accountId,
      category: 'connection_needs_attention',
      title: 'Reconnect Depop',
      body: "Listora's Depop access expired.",
      urgency: 'normal',
      threadId: 'connection:depop',
      data: { marketplace: 'depop' },
    });
  });

  it("shortens a marketplace's long message so the notification is still valid", () => {
    const notification = connectionBrokenNotification({ ...broken, message: 'x'.repeat(2_000) });
    expect(notification.body).toHaveLength(PUSH_BODY_MAX_LENGTH);
    expect(notification.body.endsWith('…')).toBe(true);
    expect(() => parsePushNotification(notification)).not.toThrow();
    expect(connectionBrokenNotification({ ...broken, message: '  ' }).body).toBe(
      'Open Listora to see what it needs.',
    );
  });
});
