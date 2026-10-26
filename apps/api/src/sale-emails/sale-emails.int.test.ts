/**
 * Email sale detection through the API (real Postgres): the forwarding address and its honest
 * status, the "ask before auto-delist" setting, the dev drop endpoint, and finishing the confirm
 * and review tasks a sale email made, which record the sale and start its auto-delist.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createInventoryItem, type Marketplace } from '@listora/db';
import { FolderMailSource, runEmailIngest } from '@listora/email-sales';
import { createMarketplaceAdapters } from '@listora/marketplaces';
import { createLogger } from '@listora/shared';

import { createTestApi, fieldsOf, type TestApi } from '../test-support.ts';
import type { Tenant } from '../tenancy.ts';

const DOMAIN = 'in.listora.test';
const OWNER = 'emails.owner@example.com';
const OTHER = 'emails.other@example.com';
const silent = createLogger({ service: 'test', level: 'silent' });
const adapters = createMarketplaceAdapters({
  fakeMarketplaceUrl: undefined,
  ebay: undefined,
  depop: undefined,
}).lookup;

/** A synthetic sold email, as the receiving server delivered it (packages/email-sales/fixtures). */
function soldEmail(
  to: string,
  options: { title: string; messageId: string; dkim?: string | null },
): string {
  const dkim =
    options.dkim === undefined
      ? 'dkim=pass header.d=poshmark.com'
      : options.dkim === null
        ? 'dkim=none'
        : `dkim=pass header.d=${options.dkim}`;
  return [
    `Delivered-To: ${to}`,
    `Authentication-Results: mx.listora.test; spf=pass smtp.mailfrom=forwarder.example; ${dkim}`,
    'From: Poshmark <orders@poshmark.com>',
    'Subject: You made a sale on Poshmark!',
    'Date: Sat, 24 Oct 2026 18:42:10 +0000',
    `Message-ID: <${options.messageId}@poshmark.com>`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Congratulations! Your item sold.',
    '',
    `Item: ${options.title}`,
    'Price: $45.00',
    `Order ID: ${options.messageId}`,
    '',
  ].join('\r\n');
}

describe('sale emails (real Postgres)', () => {
  let api: TestApi;
  let inboxDir: string;
  let token: string;
  let tenant: Tenant;

  beforeAll(async () => {
    inboxDir = await mkdtemp(join(tmpdir(), 'listora-api-inbox-'));
    api = await createTestApi('sale_emails', {
      saleEmails: { ingest: { driver: 'folder', inboundDomain: DOMAIN, inboxDir } },
    });
    token = await api.signIn(OWNER);
    tenant = await api.tenantOf(OWNER);
  });

  afterAll(async () => {
    await api.close();
    await rm(inboxDir, { recursive: true, force: true });
  });

  async function address(): Promise<string> {
    const result = await api.call('getSaleEmails', { token });
    expect(result.status).toBe(200);
    if (result.body.address === undefined) throw new Error('no address');
    return result.body.address;
  }

  /** Posts a raw message to the dev drop endpoint and runs the worker's ingest job. */
  async function deliver(raw: string) {
    const dropped = await api.app.inject({
      method: 'POST',
      url: '/dev/email',
      headers: { 'content-type': 'message/rfc822' },
      payload: raw,
    });
    expect(dropped.statusCode).toBe(202);
    return runEmailIngest({
      db: api.db,
      adapters,
      logger: silent,
      inboundDomain: DOMAIN,
      source: new FolderMailSource(inboxDir),
    });
  }

  async function listedItem(title: string, marketplaces: readonly Marketplace[]) {
    const item = await createInventoryItem(api.db, tenant.accountId, { title, status: 'listed' });
    for (const marketplace of marketplaces) {
      await api.db
        .insertInto('marketplace_listing')
        .values({
          account_id: tenant.accountId,
          item_id: item.id,
          marketplace,
          status: 'active',
          external_listing_id: `ext-${crypto.randomUUID()}`,
          price_cents: 5000,
        })
        .execute();
    }
    return item;
  }

  async function openEmailTasks() {
    const result = await api.call('listTasks', { token, query: { status: ['open'] } });
    expect(result.status).toBe(200);
    return result.body.data.filter((task) => task.saleEmail !== undefined);
  }

  async function salesOf(itemId: string) {
    return api.db
      .selectFrom('sale_item')
      .innerJoin('sale', 'sale.id', 'sale_item.sale_id')
      .select(['sale.id', 'sale.detection_source', 'sale_item.sale_price_cents'])
      .where('sale_item.item_id', '=', itemId)
      .execute();
  }

  it('gives each account its own private forwarding address, the setup steps, and an honest status', async () => {
    const first = await api.call('getSaleEmails', { token });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      address: expect.stringMatching(/^sales\+[a-z2-7]{20}@in\.listora\.test$/) as string,
      status: 'not_set_up',
      statusDisplay: { tone: 'action_needed', label: 'Not set up' },
      askBeforeDelist: false,
      filter: 'from:(poshmark.com OR mercari.com OR depop.com) subject:(sold OR sale)',
    });
    expect(first.body.steps.length).toBeGreaterThan(2);
    expect(first.body.confirmation).toBeUndefined();
    expect((await api.call('getSaleEmails', { token })).body.address).toBe(first.body.address);

    const other = await api.call('getSaleEmails', { token: await api.signIn(OTHER) });
    expect(other.body.address).not.toBe(first.body.address);
  });

  it('saves "ask before auto-delist" and refuses a body without it', async () => {
    const on = await api.call('replaceSaleEmailSettings', {
      token,
      body: { askBeforeDelist: true },
    });
    expect(on.status).toBe(200);
    expect(on.body.askBeforeDelist).toBe(true);
    expect((await api.call('getSaleEmails', { token })).body.askBeforeDelist).toBe(true);
    const bad = await api.call('replaceSaleEmailSettings', { token, body: {} });
    expect(bad.status).toBe(422);
    expect(fieldsOf(bad)).toEqual(['askBeforeDelist']);
    await api.call('replaceSaleEmailSettings', { token, body: { askBeforeDelist: false } });
  });

  it('shows the provider’s forwarding confirmation until forwarding works', async () => {
    const to = await address();
    const confirmation = [
      `Delivered-To: ${to}`,
      'Authentication-Results: mx.listora.test; spf=pass smtp.mailfrom=google.com; dkim=pass header.d=google.com',
      'From: Gmail Team <forwarding-noreply@google.com>',
      'Subject: (#418273645) Gmail Forwarding Confirmation - Receive Mail from seller@example.com',
      'Message-ID: <confirm-1@google.com>',
      '',
      'Confirmation code: 418273645',
      'Confirm: https://mail-settings.google.com/mail/vf-synthetic',
      '',
    ].join('\r\n');
    expect(await deliver(confirmation)).toEqual({ confirmation: 1 });
    const confirming = await api.call('getSaleEmails', { token });
    expect(confirming.body).toMatchObject({
      status: 'confirming',
      confirmation: {
        provider: 'Gmail',
        code: '418273645',
        url: 'https://mail-settings.google.com/mail/vf-synthetic',
      },
    });
    expect(await readdir(inboxDir)).toEqual([]);

    // A Poshmark email that passes the sender checks proves forwarding works.
    const offer = soldEmail(to, { title: 'Anything', messageId: 'offer-1' }).replace(
      'Subject: You made a sale on Poshmark!',
      'Subject: You received an offer',
    );
    expect(await deliver(offer)).toEqual({ not_a_sale: 1 });
    const working = await api.call('getSaleEmails', { token });
    expect(working.body).toMatchObject({
      status: 'working',
      statusDisplay: { tone: 'success', label: 'Working' },
    });
    expect(working.body.confirmation).toBeUndefined();
    // The connection health summary says the same.
    const health = await api.call('getConnectionHealth', { token });
    expect(health.body.saleForwarding).toEqual({
      status: 'working',
      statusDisplay: working.body.statusDisplay,
    });
  });

  it('refuses an empty drop', async () => {
    const empty = await api.app.inject({
      method: 'POST',
      url: '/dev/email',
      headers: { 'content-type': 'message/rfc822' },
      payload: '',
    });
    expect(empty.statusCode).toBe(422);
  });

  it('confirming an email’s sale records it and starts its auto-delist; dismissing records nothing', async () => {
    const to = await address();
    await api.call('replaceSaleEmailSettings', { token, body: { askBeforeDelist: true } });
    const jacket = await listedItem('Wool Peacoat Navy', ['poshmark', 'mercari']);
    const scarf = await listedItem('Silk Scarf Floral', ['poshmark']);
    expect(
      await deliver(soldEmail(to, { title: 'Wool Peacoat Navy', messageId: 'coat-1' })),
    ).toEqual({ confirm_task: 1 });
    expect(
      await deliver(soldEmail(to, { title: 'Silk Scarf Floral', messageId: 'scarf-1' })),
    ).toEqual({ confirm_task: 1 });
    await api.call('replaceSaleEmailSettings', { token, body: { askBeforeDelist: false } });

    const tasks = await openEmailTasks();
    const coatTask = tasks.find((task) => task.itemId === jacket.id);
    expect(coatTask).toMatchObject({
      kind: 'confirm_sale',
      urgency: 'urgent',
      marketplace: 'poshmark',
      title: 'Sold on Poshmark? Confirm to delist',
      saleEmail: {
        reason: 'ask_before_delist',
        title: 'Wool Peacoat Navy',
        salePrice: { amountCents: 4500, currency: 'USD' },
        orderNumber: 'coat-1',
        candidates: [],
      },
    });
    expect(await salesOf(jacket.id)).toEqual([]);

    const done = await api.call('completeTask', {
      token,
      params: { taskId: coatTask?.id ?? '' },
      body: {},
    });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'completed', saleId: expect.any(String) as string });
    expect(await salesOf(jacket.id)).toEqual([
      { id: done.body.saleId, detection_source: 'email', sale_price_cents: 4500 },
    ]);
    const item = await api.call('getItem', { token, params: { itemId: jacket.id } });
    expect(item.body.status).toBe('sold_pending_delist');

    const scarfTask = tasks.find((task) => task.itemId === scarf.id);
    const dismissed = await api.call('dismissTask', {
      token,
      params: { taskId: scarfTask?.id ?? '' },
    });
    expect(dismissed.body.status).toBe('dismissed');
    expect(await salesOf(scarf.id)).toEqual([]);
  });

  it('a review task records the item the seller picks, or nothing when none sold', async () => {
    const to = await address();
    const first = await listedItem('Denim Jacket Vintage', ['poshmark']);
    const second = await listedItem('Denim Jacket Vintage', ['poshmark']);
    expect(
      await deliver(soldEmail(to, { title: 'Denim Jacket Vintage', messageId: 'denim-1' })),
    ).toEqual({ review_task: 1 });
    expect(
      await deliver(soldEmail(to, { title: 'Denim Jacket Vintage', messageId: 'denim-2' })),
    ).toEqual({ review_task: 1 });

    const [review, other] = await openEmailTasks().then((tasks) =>
      tasks.filter((task) => task.kind === 'review_match'),
    );
    expect(review).toMatchObject({
      title: 'Which item sold on Poshmark?',
      saleEmail: { reason: 'ambiguous_match', title: 'Denim Jacket Vintage' },
    });
    expect(new Set(review?.saleEmail?.candidates.map((candidate) => candidate.id))).toEqual(
      new Set([first.id, second.id]),
    );
    expect(review?.saleEmail?.candidates[0]).toMatchObject({
      sku: expect.stringMatching(/^[A-Z]{2,4}-\d{6}$/) as string,
      title: 'Denim Jacket Vintage',
    });

    const taskId = review?.id ?? '';
    const neither = await api.call('completeTask', { token, params: { taskId }, body: {} });
    expect(neither.status).toBe(422);
    const both = await api.call('completeTask', {
      token,
      params: { taskId },
      body: { matchedItemId: first.id, rejectMatch: true },
    });
    expect(both.status).toBe(422);
    const foreign = await createInventoryItem(api.db, (await api.tenantOf(OTHER)).accountId, {
      title: 'Not yours',
    });
    const notMine = await api.call('completeTask', {
      token,
      params: { taskId },
      body: { matchedItemId: foreign.id },
    });
    expect(notMine.status).toBe(422);
    expect(fieldsOf(notMine)).toEqual(['matchedItemId']);

    const picked = await api.call('completeTask', {
      token,
      params: { taskId },
      body: { matchedItemId: second.id },
    });
    expect(picked.status).toBe(200);
    expect(await salesOf(second.id)).toEqual([
      expect.objectContaining({ detection_source: 'email', sale_price_cents: 4500 }),
    ]);
    expect(await salesOf(first.id)).toEqual([]);

    const rejected = await api.call('completeTask', {
      token,
      params: { taskId: other?.id ?? '' },
      body: { rejectMatch: true },
    });
    expect(rejected.status).toBe(200);
    expect(rejected.body.saleId).toBeUndefined();
    expect(await salesOf(first.id)).toEqual([]);
  });

  it('never acts on a spoofed sold email', async () => {
    const to = await address();
    const bag = await listedItem('Leather Tote Black', ['poshmark', 'mercari']);
    expect(
      await deliver(
        soldEmail(to, { title: 'Leather Tote Black', messageId: 'spoof-1', dkim: 'evil.example' }),
      ),
    ).toEqual({
      rejected: 1,
    });
    expect(await salesOf(bag.id)).toEqual([]);
    expect(
      await openEmailTasks().then((tasks) =>
        tasks.filter((task) => task.saleEmail?.title === 'Leather Tote Black'),
      ),
    ).toEqual([]);
  });

  it('shows no address where this deployment reads no mail', async () => {
    const off = await createTestApi('sale_emails_off');
    try {
      const result = await off.call('getSaleEmails', { token: await off.signIn(OWNER) });
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        status: 'unavailable',
        statusDisplay: { label: 'Not available yet' },
      });
      expect(result.body.address).toBeUndefined();
      const health = await off.call('getConnectionHealth', { token: await off.signIn(OWNER) });
      expect(health.body.saleForwarding.status).toBe('needs_domain');
      const drop = await off.app.inject({
        method: 'POST',
        url: '/dev/email',
        headers: { 'content-type': 'message/rfc822' },
        payload: 'x',
      });
      // No such route: nothing is dropped anywhere.
      expect(drop.statusCode).toBeGreaterThanOrEqual(400);
      expect(drop.statusCode).toBeLessThan(500);
    } finally {
      await off.close();
    }
  });
});
