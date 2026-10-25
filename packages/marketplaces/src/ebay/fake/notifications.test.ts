/**
 * The fake's signed notifications verify exactly the way eBay's own SDKs verify eBay's
 * (github.com/eBay/event-notification-nodejs-sdk, lib/validator.js): the same procedure that
 * accepts eBay's published test vector accepts the fake's notifications and rejects tampered
 * ones.
 */
import { createVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FakeEbay } from './fake-ebay.ts';

interface Vector {
  signature: string;
  message: unknown;
  publicKey: { key: string; algorithm: string; digest: string };
  publicKeyId: string;
}

const vector = JSON.parse(
  readFileSync(new URL('__fixtures__/ebay-sdk-signature-vector.json', import.meta.url), 'utf8'),
) as Vector;

/** eBay's SDK procedure: decode the header, then ECDSA-SHA1 over the body with the PEM key. */
function verify(body: string, header: string, publicKey: string): boolean {
  const { signature } = JSON.parse(Buffer.from(header, 'base64').toString('ascii')) as {
    signature: string;
  };
  const pem = publicKey
    .replace(/-----BEGIN PUBLIC KEY-----/, '-----BEGIN PUBLIC KEY-----\n')
    .replace(/-----END PUBLIC KEY-----/, '\n-----END PUBLIC KEY-----');
  const verifier = createVerify('SHA1');
  verifier.update(body);
  return verifier.verify(pem, signature, 'base64');
}

const keyIdOf = (header: string): string =>
  (JSON.parse(Buffer.from(header, 'base64').toString('ascii')) as { kid: string }).kid;

describe('fake eBay notifications', () => {
  let fake: FakeEbay;

  beforeAll(async () => {
    fake = await FakeEbay.start();
  });

  afterAll(async () => {
    await fake.close();
  });

  it("verifies eBay's own test vector with the SDK procedure", () => {
    expect(verify(JSON.stringify(vector.message), vector.signature, vector.publicKey.key)).toBe(
      true,
    );
    expect(keyIdOf(vector.signature)).toBe(vector.publicKeyId);
  });

  it('signs notifications that the same procedure accepts, with the key getPublicKey serves', async () => {
    const notification = fake.notification('ORDER_CONFIRMATION', {
      user: { userId: 'fakeUser1', username: 'listora_dev_seller' },
      order: {
        orderId: '10-10000-20000',
        orderLineItems: [
          { orderLineItemId: '10-10000-20000-1', listingId: '110000000001', quantity: 1 },
        ],
      },
    });
    expect(notification.message.metadata).toEqual({
      topic: 'ORDER_CONFIRMATION',
      schemaVersion: '1.0',
      deprecated: false,
    });
    expect(notification.body).toBe(JSON.stringify(notification.message));
    const header = JSON.parse(
      Buffer.from(notification.signature, 'base64').toString('ascii'),
    ) as Record<string, unknown>;
    expect(header).toMatchObject({ alg: 'ecdsa', kid: fake.notificationKeyId, digest: 'SHA1' });

    const token = await applicationToken(fake);
    const response = await fetch(
      `${fake.url}/commerce/notification/v1/public_key/${keyIdOf(notification.signature)}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(response.status).toBe(200);
    const publicKey = (await response.json()) as Vector['publicKey'];
    expect(publicKey).toMatchObject({ algorithm: 'ECDSA', digest: 'SHA1' });
    expect(publicKey.key).not.toContain('\n');

    expect(verify(notification.body, notification.signature, publicKey.key)).toBe(true);
    const tampered = notification.body.replace('110000000001', '110000000002');
    expect(verify(tampered, notification.signature, publicKey.key)).toBe(false);
    expect(verify(notification.body, vector.signature, publicKey.key)).toBe(false);
  });

  it('answers getPublicKey for an unknown key id with 404', async () => {
    const token = await applicationToken(fake);
    const response = await fetch(`${fake.url}/commerce/notification/v1/public_key/unknown`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(404);
  });

  it('delivers a notification to a subscriber with its signature header', async () => {
    const { createServer } = await import('node:http');
    const received: { body: string; signature: string | undefined }[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received.push({
          body: Buffer.concat(chunks).toString('utf8'),
          signature: request.headers['x-ebay-signature'] as string | undefined,
        });
        response.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    const notification = fake.notification('MARKETPLACE_ACCOUNT_DELETION', {
      username: 'listora_dev_seller',
      userId: 'fakeUser1',
      eiasToken: 'nY+sHZ2PrBmdj6wVnY+sEZ2PrA2dj6wJnY+gAZGEpwmdj6x9nY+seQ==',
    });
    expect(await fake.deliver(`http://127.0.0.1:${String(port)}/ebay`, notification)).toBe(204);
    expect(received).toEqual([{ body: notification.body, signature: notification.signature }]);
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });
});

async function applicationToken(fake: FakeEbay): Promise<string> {
  const { FAKE_EBAY_CLIENT_ID, FAKE_EBAY_CLIENT_SECRET } = await import('./constants.ts');
  const response = await fetch(`${fake.url}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${FAKE_EBAY_CLIENT_ID}:${FAKE_EBAY_CLIENT_SECRET}`).toString('base64')}`,
    },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
  });
  return ((await response.json()) as { access_token: string }).access_token;
}
