import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  ebayChallengeResponse,
  EBAY_VERIFICATION_TOKEN_PATTERN,
  InvalidEbayNotificationError,
  notificationUserId,
  parseEbayNotification,
} from './notification-events.ts';

const envelope = (topic: string, data: Record<string, unknown>): unknown => ({
  metadata: { topic, schemaVersion: '1.0', deprecated: false },
  notification: {
    notificationId: 'n-1',
    eventDate: '2026-10-24T10:00:00.000Z',
    publishDate: '2026-10-24T10:00:01.000Z',
    publishAttemptCount: 1,
    data,
  },
});

describe('parseEbayNotification', () => {
  it('reads an order confirmation (asyncapi ORDER_CONFIRMATION 1.0)', () => {
    const parsed = parseEbayNotification(
      envelope('ORDER_CONFIRMATION', {
        user: { userId: 'u1', username: 'seller' },
        order: {
          orderId: '12-34567-89012',
          orderLineItems: [
            { orderLineItemId: 'l1', listingId: '110000000001', quantity: 2 },
            { orderLineItemId: 'l2', listingId: '110000000002' },
          ],
        },
      }),
    );
    expect(parsed).toEqual({
      topic: 'ORDER_CONFIRMATION',
      notificationId: 'n-1',
      schemaVersion: '1.0',
      eventDate: new Date('2026-10-24T10:00:00.000Z'),
      sellerUserId: 'u1',
      orderId: '12-34567-89012',
      lines: [
        { lineItemId: 'l1', listingId: '110000000001', quantity: 2 },
        { lineItemId: 'l2', listingId: '110000000002', quantity: 1 },
      ],
    });
    expect(notificationUserId(parsed)).toBe('u1');
  });

  it('reads listing events and the account deletion, by immutable user id only', () => {
    const listing = parseEbayNotification(
      envelope('LISTING', {
        listingId: '110000000001',
        reason: 'ENDED',
        user: { userId: 'u1', username: 'u1' },
      }),
    );
    expect(listing).toMatchObject({ topic: 'LISTING', listingId: '110000000001', reason: 'ENDED' });

    const deletion = parseEbayNotification(
      envelope('MARKETPLACE_ACCOUNT_DELETION', {
        username: 'someone',
        userId: 'u9',
        eiasToken: 'nY+sHZ2PrBmdj6wVnY+sEZ2PrA2dj6wJnY+gAZGEpwmdj6x9nY+seQ==',
      }),
    );
    expect(deletion).toMatchObject({ topic: 'MARKETPLACE_ACCOUNT_DELETION', userId: 'u9' });
    expect(notificationUserId(deletion)).toBe('u9');
  });

  it('reads topics Listora does not act on as unhandled', () => {
    const parsed = parseEbayNotification(envelope('ITEM_MARKED_SHIPPED', { anything: true }));
    expect(parsed).toMatchObject({ topic: 'unhandled', ebayTopic: 'ITEM_MARKED_SHIPPED' });
    expect(notificationUserId(parsed)).toBeNull();
  });

  it('refuses envelopes and data that lack what Listora needs', () => {
    expect(() => parseEbayNotification({ metadata: {} })).toThrow(InvalidEbayNotificationError);
    expect(() =>
      parseEbayNotification(envelope('ORDER_CONFIRMATION', { user: { userId: 'u1' } })),
    ).toThrow(InvalidEbayNotificationError);
    expect(() =>
      parseEbayNotification(
        envelope('LISTING', { listingId: '1', reason: 'DELETED', user: { userId: 'u1' } }),
      ),
    ).toThrow(InvalidEbayNotificationError);
  });
});

describe('ebayChallengeResponse', () => {
  it('hashes challengeCode + verificationToken + endpoint with SHA-256, in that order', () => {
    const token = 'listora_verification_token_0123456789abcdef';
    const endpoint = 'https://api.listora.app/webhooks/ebay';
    expect(ebayChallengeResponse('a8628072-3d33-45ee-9004-bee86830a22d', token, endpoint)).toBe(
      createHash('sha256')
        .update(`a8628072-3d33-45ee-9004-bee86830a22d${token}${endpoint}`)
        .digest('hex'),
    );
  });

  it("follows eBay's verification token rule", () => {
    expect(EBAY_VERIFICATION_TOKEN_PATTERN.test('a'.repeat(32))).toBe(true);
    expect(EBAY_VERIFICATION_TOKEN_PATTERN.test('a'.repeat(31))).toBe(false);
    expect(EBAY_VERIFICATION_TOKEN_PATTERN.test(`${'a'.repeat(32)}!`)).toBe(false);
    expect(EBAY_VERIFICATION_TOKEN_PATTERN.test('a'.repeat(81))).toBe(false);
  });
});
