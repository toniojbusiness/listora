import { describe, expect, it } from 'vitest';

import { InvalidNotificationError, parseAuthorizationRevocation } from './notifications.ts';

/** The shape of eBay's AUTHORIZATION_REVOCATION schema (asyncapi, schemaVersion 1.0). */
function notification(data: Record<string, unknown>, topic = 'AUTHORIZATION_REVOCATION') {
  return {
    metadata: { topic, schemaVersion: '1.0', deprecated: false },
    notification: {
      notificationId: '49f6dd8f-4ef6-4a0c-9f27-1d5c9c1e8f2a_33',
      eventDate: '2026-10-24T10:00:00.000Z',
      publishDate: '2026-10-24T10:00:02.000Z',
      publishAttemptCount: 1,
      data,
    },
  };
}

describe('parseAuthorizationRevocation', () => {
  it("reads the seller's immutable user id, the reason, and the revocation date", () => {
    expect(
      parseAuthorizationRevocation(
        notification({
          username: 'listora_seller',
          userId: 'fake-ebay-user-1',
          eiasToken: 'nY+sHZ2PrBmdj6wVnY+sEZ2PrA2dj6',
          revokeReason: 'REVOKED_BY_USER',
          revocationDate: '2026-10-24T09:59:00.000Z',
        }),
      ),
    ).toEqual({
      notificationId: '49f6dd8f-4ef6-4a0c-9f27-1d5c9c1e8f2a_33',
      externalUserId: 'fake-ebay-user-1',
      reason: 'REVOKED_BY_USER',
      revokedAt: new Date('2026-10-24T09:59:00.000Z'),
    });
  });

  it('falls back to the event date and treats an unknown reason as revoked by eBay', () => {
    expect(
      parseAuthorizationRevocation(notification({ userId: 'u1', revokeReason: 'SOMETHING_NEW' })),
    ).toMatchObject({ reason: 'REVOKED_BY_EBAY', revokedAt: new Date('2026-10-24T10:00:00.000Z') });
  });

  it('refuses another topic or a payload without a user id', () => {
    expect(() =>
      parseAuthorizationRevocation(notification({ userId: 'u1' }, 'ORDER_CONFIRMATION')),
    ).toThrow(InvalidNotificationError);
    expect(() =>
      parseAuthorizationRevocation(notification({ username: 'listora_seller' })),
    ).toThrow(InvalidNotificationError);
    expect(() => parseAuthorizationRevocation('not json')).toThrow(InvalidNotificationError);
  });
});
