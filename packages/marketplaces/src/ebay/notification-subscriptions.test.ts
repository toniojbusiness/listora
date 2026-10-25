import { createServer, type Server } from 'node:http';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  FAKE_EBAY_CLIENT_ID,
  FAKE_EBAY_CLIENT_SECRET,
  FAKE_EBAY_REFRESH_TOKEN,
} from './fake/constants.ts';
import { FakeEbay } from './fake/fake-ebay.ts';
import { ebayChallengeResponse } from './notification-events.ts';
import { EbayNotificationSubscriptions } from './notification-subscriptions.ts';
import { ApplicationToken, EbayOAuthClient } from './oauth.ts';

const TOKEN = 'listora-test-verification-token-0123456789';

/** A notification endpoint that answers eBay's challenge (or not) and records deliveries. */
async function startEndpoint(): Promise<{
  url: string;
  received: { body: string; signature: string | undefined }[];
  answerChallenge: { value: boolean };
  close: () => Promise<void>;
}> {
  const received: { body: string; signature: string | undefined }[] = [];
  const answerChallenge = { value: true };
  let url = '';
  const server: Server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET') {
      const code = requestUrl.searchParams.get('challenge_code') ?? '';
      const challengeResponse = answerChallenge.value
        ? ebayChallengeResponse(code, TOKEN, url)
        : 'wrong';
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ challengeResponse }));
      return;
    }
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
  url = `http://127.0.0.1:${String((server.address() as { port: number }).port)}/webhooks/ebay`;
  return {
    url,
    received,
    answerChallenge,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

describe('EbayNotificationSubscriptions', () => {
  let fake: FakeEbay;
  let endpoint: Awaited<ReturnType<typeof startEndpoint>>;
  let oauth: EbayOAuthClient;
  const signal = (): AbortSignal => AbortSignal.timeout(10_000);

  beforeAll(async () => {
    fake = await FakeEbay.start({ allowHttpNotificationEndpoints: true });
    endpoint = await startEndpoint();
    oauth = new EbayOAuthClient({
      tokenUrl: `${fake.url}/identity/v1/oauth2/token`,
      clientId: FAKE_EBAY_CLIENT_ID,
      clientSecret: FAKE_EBAY_CLIENT_SECRET,
    });
  });

  afterAll(async () => {
    await fake.close();
    await endpoint.close();
  });

  afterEach(() => {
    fake.clearFaults();
    endpoint.answerChallenge.value = true;
  });

  const manager = (alertEmail: string | null = 'alerts@listora.test') =>
    new EbayNotificationSubscriptions({
      endpoints: { api: fake.url },
      applicationToken: new ApplicationToken(oauth),
      settings: { endpoint: endpoint.url, verificationToken: TOKEN, alertEmail },
    });
  const sellerToken = async (): Promise<string> =>
    (await oauth.refreshUserToken(FAKE_EBAY_REFRESH_TOKEN, [], signal())).token;

  it('needs an alert email before eBay accepts a destination', async () => {
    expect(await manager(null).ensureDestination(signal())).toMatchObject({
      type: 'config_required',
      code: 'alert_email_required',
    });
  });

  it('refuses a destination whose endpoint fails the challenge', async () => {
    endpoint.answerChallenge.value = false;
    expect(await manager().ensureDestination(signal())).toMatchObject({
      type: 'challenge_failed',
      code: 'ebay_195020',
    });
    expect(fake.notifications.destinations.size).toBe(0);
  });

  it('subscribes every topic once, and delivers eBay events to the endpoint', async () => {
    const subject = manager();
    const destination = await subject.ensureDestination(signal());
    if (destination.type !== 'ready') throw new Error(destination.type);
    expect(fake.notifications.alertEmail).toBe('alerts@listora.test');

    const app = await subject.ensureApplicationTopics(destination.destinationId, signal());
    expect(app.map((result) => [result.topicId, result.type])).toEqual([
      ['MARKETPLACE_ACCOUNT_DELETION', 'subscribed'],
      ['AUTHORIZATION_REVOCATION', 'subscribed'],
    ]);
    const seller = await subject.ensureSellerTopics(
      destination.destinationId,
      await sellerToken(),
      signal(),
    );
    expect(seller.map((result) => [result.topicId, result.type])).toEqual([
      ['ORDER_CONFIRMATION', 'subscribed'],
      ['LISTING', 'subscribed'],
    ]);

    // Running it again changes nothing.
    const again = manager();
    expect(await again.ensureDestination(signal())).toEqual(destination);
    await again.ensureApplicationTopics(destination.destinationId, signal());
    await again.ensureSellerTopics(destination.destinationId, await sellerToken(), signal());
    expect(fake.notifications.destinations.size).toBe(1);
    expect(fake.notifications.subscriptions.size).toBe(4);

    const sent = await fake.notifications.publish(
      'ORDER_CONFIRMATION',
      { user: { userId: 'fakeUser1' }, order: { orderId: '1', orderLineItems: [] } },
      'fakeUser1',
    );
    expect(sent).toHaveLength(1);
    expect(endpoint.received.at(-1)).toEqual({
      body: sent[0]?.body,
      signature: sent[0]?.signature,
    });
    // Another seller's events never reach this seller's subscription.
    expect(
      await fake.notifications.publish(
        'ORDER_CONFIRMATION',
        { user: { userId: 'other' }, order: { orderId: '2', orderLineItems: [] } },
        'other',
      ),
    ).toHaveLength(0);
  });

  it('enables a subscription someone disabled, and reports refused topics per topic', async () => {
    const subject = manager();
    const destination = await subject.ensureDestination(signal());
    if (destination.type !== 'ready') throw new Error(destination.type);
    for (const subscription of fake.notifications.subscriptions.values()) {
      subscription.status = 'DISABLED';
    }
    await subject.ensureApplicationTopics(destination.destinationId, signal());
    const statuses = [...fake.notifications.subscriptions.values()]
      .filter((subscription) => subscription.owner === null)
      .map((subscription) => subscription.status);
    expect(statuses).toEqual(['ENABLED', 'ENABLED']);

    // A seller topic subscribed with the application's token is refused by eBay (195011).
    const wrongToken = await new ApplicationToken(oauth).get(signal());
    const refused = await subject.ensureSellerTopics(
      destination.destinationId,
      wrongToken,
      signal(),
    );
    expect(refused.every((result) => result.type === 'not_authorized')).toBe(true);

    // A seller token eBay no longer accepts is told apart, so the caller refreshes it.
    const stale = await sellerToken();
    fake.expireAccessTokens();
    const rejected = await subject.ensureSellerTopics(destination.destinationId, stale, signal());
    expect(rejected.map((result) => result.type)).toEqual(['token_rejected', 'token_rejected']);
  });

  it('uses the destination another worker created at the same time', async () => {
    const fresh = await FakeEbay.start({ allowHttpNotificationEndpoints: true });
    try {
      const freshOauth = new EbayOAuthClient({
        tokenUrl: `${fresh.url}/identity/v1/oauth2/token`,
        clientId: FAKE_EBAY_CLIENT_ID,
        clientSecret: FAKE_EBAY_CLIENT_SECRET,
      });
      const make = () =>
        new EbayNotificationSubscriptions({
          endpoints: { api: fresh.url },
          applicationToken: new ApplicationToken(freshOauth),
          settings: { endpoint: endpoint.url, verificationToken: TOKEN, alertEmail: 'a@b.test' },
        });
      const [first, second] = await Promise.all([
        make().ensureDestination(signal()),
        make().ensureDestination(signal()),
      ]);
      expect(first).toMatchObject({ type: 'ready' });
      expect(second).toEqual(first);
      expect(fresh.notifications.destinations.size).toBe(1);
    } finally {
      await fresh.close();
    }
  });

  it('reports eBay outages as unavailable', async () => {
    fake.inject({ action: 'notification', fault: { type: 'server_error' }, times: 10 });
    expect(await manager().ensureDestination(signal())).toMatchObject({ type: 'unavailable' });
  });
});
