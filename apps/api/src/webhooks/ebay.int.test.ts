/**
 * eBay's notification endpoint end to end: the API serving `/webhooks/ebay`, the fake eBay
 * signing with its test ECC key and delivering to the subscribed destination, and the stored
 * events and jobs in a real Postgres. Signed fixtures verify, bad signatures are refused with
 * nothing stored, repeats are ignored, a revocation flips the connection at once, and an
 * account deletion purges the eBay user's data.
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ApplicationToken,
  createEbayAdapter,
  desiredStateForContent,
  EbayNotificationSubscriptions,
  EbayNotificationVerifier,
  EbayOAuthClient,
  FAKE_EBAY_REFRESH_TOKEN,
  FakeEbay,
  loadEbayConfig,
  type EbayConfig,
} from '@listora/marketplaces';
import { sampleListingContent } from '@listora/marketplaces/testing';
import { isEbayUserDeletionPayload, purgeEbayUser } from '@listora/sales';
import { createLogger } from '@listora/shared';

import { createTestApi, type TestApi } from '../test-support.ts';
import { EBAY_WEBHOOK_PATH } from './ebay.ts';

const TOKEN = 'listora-webhook-test-verification-token-0123';
const logger = createLogger({ service: 'webhook-test', level: 'silent' });
const signal = (): AbortSignal => AbortSignal.timeout(10_000);

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return port;
}

describe('POST /webhooks/ebay', () => {
  let fake: FakeEbay;
  let api: TestApi;
  let endpoint: string;
  let config: EbayConfig;
  let accountId: string;
  let connectionId: string;

  beforeAll(async () => {
    fake = await FakeEbay.start({ allowHttpNotificationEndpoints: true });
    endpoint = `http://127.0.0.1:${String(await freePort())}${EBAY_WEBHOOK_PATH}`;
    const loaded = loadEbayConfig({
      EBAY_ENV: 'fake',
      EBAY_FAKE_URL: fake.url,
      EBAY_NOTIFICATION_ENDPOINT: endpoint,
      EBAY_NOTIFICATION_VERIFICATION_TOKEN: TOKEN,
    });
    if (loaded?.notifications === undefined) throw new Error('no eBay notification config');
    config = loaded;
    const oauth = new EbayOAuthClient({
      tokenUrl: config.endpoints.oauthToken,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    });
    api = await createTestApi('ebay_webhook', {
      ebayWebhook: {
        verifier: new EbayNotificationVerifier({
          endpoints: config.endpoints,
          token: new ApplicationToken(oauth),
        }),
        endpoint,
        verificationToken: TOKEN,
      },
    });
    await api.app.listen({ host: '127.0.0.1', port: Number(new URL(endpoint).port) });
    accountId = (await api.tenantOf('seller@listora.test')).accountId;
    connectionId = await insertConnection(accountId, 'fakeUser1');
  });

  afterAll(async () => {
    await api.close();
    await fake.close();
  });

  async function insertConnection(account: string, ebayUserId: string): Promise<string> {
    const row = await api.db
      .insertInto('marketplace_connection')
      .values({
        account_id: account,
        marketplace: 'ebay',
        mode: 'api',
        external_user_id: ebayUserId,
        display_name: ebayUserId,
        token_ciphertext: Buffer.from('sealed'),
        granted_at: new Date(Date.now() - 86_400_000),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  const post = (body: string, signature?: string) =>
    api.app.inject({
      method: 'POST',
      url: EBAY_WEBHOOK_PATH,
      headers: {
        'content-type': 'application/json',
        ...(signature === undefined ? {} : { 'x-ebay-signature': signature }),
      },
      payload: body,
    });
  const events = () =>
    api.db.selectFrom('inbound_event').selectAll().orderBy('created_at').execute();
  const jobs = async (task: string) =>
    (
      await sql<{ key: string | null; payload: unknown }>`
        select job.key, job.payload from graphile_worker._private_jobs as job
        join graphile_worker._private_tasks as t on t.id = job.task_id
        where t.identifier = ${task}
      `.execute(api.db)
    ).rows;
  const orderData = (orderId: string, listingId = '110000000001') => ({
    user: { userId: 'fakeUser1', username: 'listora_dev_seller' },
    order: {
      orderId,
      orderLineItems: [{ orderLineItemId: `${orderId}-1`, listingId, quantity: 1 }],
    },
  });

  it("answers eBay's endpoint challenge", async () => {
    const response = await api.app.inject({
      method: 'GET',
      url: `${EBAY_WEBHOOK_PATH}?challenge_code=a8628072-3d33-45ee-9004-bee86830a22d`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.json()).toEqual({
      challengeResponse: createHash('sha256')
        .update(`a8628072-3d33-45ee-9004-bee86830a22d${TOKEN}${endpoint}`)
        .digest('hex'),
    });
    expect((await api.app.inject({ method: 'GET', url: EBAY_WEBHOOK_PATH })).statusCode).toBe(400);
  });

  it('stores a signed notification once and refuses bad signatures', async () => {
    const before = (await events()).length;
    const notification = fake.notification('ORDER_CONFIRMATION', orderData('20-00001-00001'));

    const tampered = notification.body.replace('20-00001-00001', '20-00001-99999');
    expect((await post(tampered, notification.signature)).statusCode).toBe(412);
    expect((await post(notification.body)).statusCode).toBe(412);
    const foreign = Buffer.from(
      JSON.stringify({ alg: 'ecdsa', kid: 'not-a-key', signature: 'AAAA', digest: 'SHA1' }),
    ).toString('base64');
    expect((await post(notification.body, foreign)).statusCode).toBe(412);
    expect(await events()).toHaveLength(before);

    expect((await post(notification.body, notification.signature)).statusCode).toBe(204);
    // eBay resends until it gets a 2xx; a repeat stores nothing new.
    expect((await post(notification.body, notification.signature)).statusCode).toBe(204);
    const stored = (await events()).slice(before);
    expect(stored).toEqual([
      expect.objectContaining({
        account_id: accountId,
        source: 'ebay_webhook',
        marketplace: 'ebay',
        provider_event_id: notification.message.notification.notificationId,
        signature_ok: true,
        external_user_id: 'fakeUser1',
        processed_at: null,
      }),
    ]);
    expect(await jobs('ebay_notification')).toContainEqual(
      expect.objectContaining({ payload: { accountId, inboundEventId: stored[0]?.id } }),
    );

    // A notification about an eBay user nobody connected, or a topic Listora ignores, is
    // acknowledged and stores nothing.
    const stranger = fake.notification('ORDER_CONFIRMATION', {
      ...orderData('20-00001-00002'),
      user: { userId: 'someoneElse' },
    });
    expect((await post(stranger.body, stranger.signature)).statusCode).toBe(204);
    const shipped = fake.notification('ITEM_MARKED_SHIPPED', { orderId: '1' });
    expect((await post(shipped.body, shipped.signature)).statusCode).toBe(204);
    expect((await events()).length).toBe(before + 1);
  });

  it('marks the connection revoked as soon as eBay says access was revoked', async () => {
    const other = (await api.tenantOf('other@listora.test')).accountId;
    const revokedConnection = await insertConnection(other, 'fakeUser9');
    const notification = fake.notification('AUTHORIZATION_REVOCATION', {
      username: 'fakeUser9',
      userId: 'fakeUser9',
      eiasToken: 'eias',
      revokeReason: 'REVOKED_BY_USER',
      revocationDate: new Date().toISOString(),
    });
    expect((await post(notification.body, notification.signature)).statusCode).toBe(204);
    expect(
      await api.db
        .selectFrom('marketplace_connection')
        .select(['status', 'token_ciphertext', 'last_error_code'])
        .where('id', '=', revokedConnection)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'revoked', token_ciphertext: null, last_error_code: 'revoked_by_seller' });
    const [stored] = await api.db
      .selectFrom('inbound_event')
      .selectAll()
      .where('account_id', '=', other)
      .execute();
    expect(stored).toMatchObject({ result: 'processed', external_user_id: 'fakeUser9' });
  });

  it('subscribes on the fake eBay, which then delivers its own events here', async () => {
    const oauth = new EbayOAuthClient({
      tokenUrl: config.endpoints.oauthToken,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    });
    const subscriptions = new EbayNotificationSubscriptions({
      endpoints: config.endpoints,
      applicationToken: new ApplicationToken(oauth),
      settings: { endpoint, verificationToken: TOKEN, alertEmail: 'ops@listora.test' },
    });
    // eBay checks the endpoint with a challenge to this API before it accepts it.
    const destination = await subscriptions.ensureDestination(signal());
    if (destination.type !== 'ready') throw new Error(JSON.stringify(destination));
    await subscriptions.ensureApplicationTopics(destination.destinationId, signal());
    const sellerToken = await oauth.refreshUserToken(FAKE_EBAY_REFRESH_TOKEN, [], signal());
    const seller = await subscriptions.ensureSellerTopics(
      destination.destinationId,
      sellerToken.token,
      signal(),
    );
    expect(seller.every((topic) => topic.type === 'subscribed')).toBe(true);

    // A buyer buys a listing on eBay: eBay posts ORDER_CONFIRMATION here.
    const listed = await listOnFake(config, connectionId);
    // Listing it was an eBay LISTING event, delivered here too.
    await fake.notifications.settled();
    expect(fake.notifications.deliveries.at(-1)).toMatchObject({ topic: 'LISTING', status: 204 });
    const before = (await events()).length;
    fake.sell(listed);
    await fake.notifications.settled();
    const delivered = fake.notifications.deliveries.filter(
      (delivery) => delivery.topic === 'ORDER_CONFIRMATION',
    );
    expect(delivered.at(-1)).toMatchObject({ endpoint, status: 204 });
    expect((await events()).slice(before)).toEqual([
      expect.objectContaining({ source: 'ebay_webhook', signature_ok: true }),
    ]);
  });

  it("purges an eBay user's data when eBay says they deleted their account", async () => {
    expect(await events()).not.toEqual([]);
    fake.deleteUser('fakeUser1');
    await fake.notifications.settled();
    expect(
      fake.notifications.deliveries.filter(
        (delivery) => delivery.topic === 'MARKETPLACE_ACCOUNT_DELETION',
      ),
    ).toEqual([expect.objectContaining({ status: 204 })]);
    const [job] = await jobs('ebay_user_deletion');
    expect(job?.key).toBe('ebay-user-deletion:fakeUser1');
    if (!isEbayUserDeletionPayload(job?.payload)) throw new Error('no deletion job');

    // The worker's job.
    await purgeEbayUser({ db: api.db, logger }, job.payload);
    expect(
      await api.db
        .selectFrom('marketplace_connection')
        .select('id')
        .where('external_user_id', '=', 'fakeUser1')
        .execute(),
    ).toEqual([]);
    expect(
      await api.db
        .selectFrom('inbound_event')
        .select('id')
        .where('external_user_id', '=', 'fakeUser1')
        .execute(),
    ).toEqual([]);
    // Another eBay user's data stays.
    expect(
      await api.db
        .selectFrom('inbound_event')
        .select('id')
        .where('external_user_id', '=', 'fakeUser9')
        .execute(),
    ).toHaveLength(1);
  });
});

/** Lists a sample item on the fake eBay for the connection; returns the eBay item id. */
async function listOnFake(config: EbayConfig, connectionId: string): Promise<string> {
  const bound = loadEbayConfig({
    EBAY_ENV: 'fake',
    EBAY_FAKE_URL: config.endpoints.api,
    EBAY_USER_CONNECTION_ID: connectionId,
  });
  if (bound === undefined) throw new Error('no config');
  const adapter = createEbayAdapter(bound, { requestTimeoutMs: 5_000 });
  const content = sampleListingContent();
  const ref = { id: connectionId, mode: 'api' } as const;
  const outcome = await adapter.execute(
    {
      operationId: 'op-webhook',
      kind: 'create',
      idempotencyKey: 'key-webhook',
      attempt: 1,
      desired: desiredStateForContent('create', content),
      listing: {
        listingId: 'webhook',
        externalListingId: null,
        externalSku: 'WH-000001',
        externalUrl: null,
      },
      payload: adapter.buildPayload(content.item, content.variant),
    },
    { signal: signal(), connection: ref },
  );
  if (outcome.type !== 'confirmed' || outcome.externalListingId === undefined) {
    throw new Error(JSON.stringify(outcome));
  }
  return outcome.externalListingId;
}
