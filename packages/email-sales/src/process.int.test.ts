/**
 * Email sale detection end to end on real Postgres, through the folder driver and the worker's
 * ingest job: a verified sold email records the sale and starts its auto-delist; a spoofed one
 * is rejected and changes nothing; an unknown format and an ambiguous match become review tasks
 * and ask for a sale check; a sale the scheduled check found is recorded once, whichever comes
 * first; "ask before auto-delist" makes a confirm task instead; and the provider's forwarding
 * confirmation is kept for the app.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createInventoryItem, type Db, type Marketplace } from '@listora/db';
import { createMigratedDatabase, insertAccount, type MigratedDatabase } from '@listora/db/testing';
import {
  createMarketplaceAdapters,
  loadDepopConfig,
  loadEbayConfig,
  type AdapterLookup,
} from '@listora/marketplaces';
import { recordSale } from '@listora/sales';
import { createLogger } from '@listora/shared';

import { forwardingAddress } from './address.ts';
import { dropInInbox, FolderMailSource } from './drivers/folder.ts';
import { emailSaleOfTask } from './email-sale.ts';
import { ensureSaleEmailInbox, findSaleEmailInbox, saveAskBeforeDelist } from './inbox.ts';
import { runEmailIngest } from './job.ts';
import type { EmailOutcome } from './process.ts';
import { deliver, fixture, type Delivery, type FixtureName } from './test-support.ts';

const DOMAIN = 'in.listora.test';
const logger = createLogger({ service: 'test', level: 'silent' });
/** Nothing listens here: the adapters are only asked for their capabilities. */
const UNUSED_URL = 'http://127.0.0.1:9';
const POSHMARK_LISTING_ID = '65f1c2a3b4d5e6f7a8b9c0d1';

describe('email sale detection (real Postgres)', () => {
  let database: MigratedDatabase;
  let db: Db;
  let adapters: AdapterLookup;
  let inboxDir: string;
  let accountId: string;
  let address: string;

  beforeAll(async () => {
    database = await createMigratedDatabase('email_sales', { jobQueue: true, max: 8 });
    db = database.db;
    const ebay = loadEbayConfig({ EBAY_ENV: 'fake', EBAY_FAKE_URL: UNUSED_URL });
    const depop = loadDepopConfig({ DEPOP_ENV: 'fake', DEPOP_FAKE_URL: UNUSED_URL });
    adapters = createMarketplaceAdapters({ fakeMarketplaceUrl: undefined, ebay, depop }).lookup;
    inboxDir = await mkdtemp(join(tmpdir(), 'listora-inbox-'));
  });

  afterAll(async () => {
    await rm(inboxDir, { recursive: true, force: true });
    await database.close();
  });

  beforeEach(async () => {
    accountId = await insertAccount(db, 'JD');
    const inbox = await ensureSaleEmailInbox(db, accountId);
    address = forwardingAddress(inbox.addressToken, DOMAIN);
  });

  async function item(title: string) {
    return createInventoryItem(db, accountId, { title, status: 'listed' });
  }

  async function listing(
    itemId: string,
    marketplace: Marketplace,
    options: { externalListingId?: string | null; title?: string; connectionId?: string } = {},
  ): Promise<string> {
    const row = await db
      .insertInto('marketplace_listing')
      .values({
        account_id: accountId,
        item_id: itemId,
        marketplace,
        status: 'active',
        external_listing_id:
          options.externalListingId === undefined
            ? `ext-${crypto.randomUUID()}`
            : options.externalListingId,
        title: options.title ?? null,
        price_cents: 5000,
        connection_id: options.connectionId ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async function automationConnection(marketplace: Marketplace): Promise<string> {
    // A working session; the vault's contents do not matter to scheduling.
    const row = await db
      .insertInto('marketplace_connection')
      .values({
        account_id: accountId,
        marketplace,
        mode: 'automation',
        status: 'connected',
        token_ciphertext: Buffer.from([0]),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /** Drops the fixture as the receiver delivered it and runs the worker's ingest job once. */
  async function receive(
    name: FixtureName,
    delivery: Partial<Delivery> = {},
  ): Promise<Partial<Record<EmailOutcome, number>>> {
    const dkim = name.split('-')[0] === 'gmail' ? 'google.com' : `${name.split('-')[0] ?? ''}.com`;
    await dropInInbox(inboxDir, deliver(fixture(name), { to: address, dkim, ...delivery }));
    return runEmailIngest({
      db,
      adapters,
      logger,
      inboundDomain: DOMAIN,
      source: new FolderMailSource(inboxDir),
    });
  }

  async function sales() {
    return db
      .selectFrom('sale')
      .innerJoin('sale_item', 'sale_item.sale_id', 'sale.id')
      .select([
        'sale.id',
        'sale.detection_source',
        'sale.external_order_id',
        'sale_item.item_id',
        'sale_item.sale_price_cents',
      ])
      .where('sale.account_id', '=', accountId)
      .execute();
  }

  async function events() {
    return db
      .selectFrom('inbound_event')
      .select(['source', 'marketplace', 'signature_ok', 'result', 'error_message', 'payload'])
      .where('account_id', '=', accountId)
      .orderBy('created_at')
      .execute();
  }

  async function tasks() {
    return db
      .selectFrom('user_task')
      .select(['kind', 'item_id', 'listing_id', 'urgency', 'payload', 'status'])
      .where('account_id', '=', accountId)
      .where('kind', 'in', ['confirm_sale', 'review_match'])
      .execute();
  }

  async function saleCheck(connectionId: string) {
    const schedule = await db
      .selectFrom('sale_check_schedule')
      .select(['next_reason'])
      .where('connection_id', '=', connectionId)
      .executeTakeFirst();
    const { rows } = await sql<{ count: number }>`
      select count(*)::int as count from graphile_worker.jobs where key = ${`sale-check:${connectionId}`}
    `.execute(db);
    return { reason: schedule?.next_reason ?? null, queued: rows[0]?.count ?? 0 };
  }

  it('records a verified sold email’s sale and starts its auto-delist everywhere else', async () => {
    const jacket = await item("Levi's Vintage Trucker Jacket Size M");
    const poshmark = await listing(jacket.id, 'poshmark', {
      externalListingId: POSHMARK_LISTING_ID,
    });
    await listing(jacket.id, 'mercari');

    expect(await receive('poshmark-sold')).toEqual({ recorded: 1 });

    expect(await sales()).toEqual([
      expect.objectContaining({
        detection_source: 'email',
        external_order_id: '6731f0a1c2b3d4e5f6a7b8c9',
        item_id: jacket.id,
        sale_price_cents: 4500,
      }),
    ]);
    const run = await db
      .selectFrom('delist_run')
      .select('id')
      .where('item_id', '=', jacket.id)
      .executeTakeFirst();
    expect(run).toBeDefined();
    const delists = await db
      .selectFrom('marketplace_operation')
      .select(['listing_id', 'kind', 'origin'])
      .where('delist_run_id', '=', run?.id ?? '')
      .execute();
    expect(delists).toEqual([expect.objectContaining({ kind: 'end', origin: 'auto_delist' })]);
    expect(delists[0]?.listing_id).not.toBe(poshmark);
    const status = await db
      .selectFrom('inventory_item')
      .select('status')
      .where('id', '=', jacket.id)
      .executeTakeFirstOrThrow();
    expect(status.status).toBe('sold_pending_delist');

    const [event] = await events();
    expect(event).toMatchObject({
      source: 'email',
      marketplace: 'poshmark',
      signature_ok: true,
      result: 'processed',
    });
    // Parsed fields and a redacted excerpt only.
    const stored = JSON.stringify(event?.payload);
    expect(stored).not.toMatch(/Alex|Main St|janes_closet/);
    expect(await readdir(inboxDir)).toEqual([]);
    const inbox = await findSaleEmailInbox(db, accountId);
    expect(inbox?.lastSaleEmailAt).toBeInstanceOf(Date);
    expect(inbox?.lastVerifiedEmailAt).toBeInstanceOf(Date);
  });

  it.each<[string, Partial<Delivery>]>([
    ['no DKIM signature', { dkim: null }],
    ['only the forwarder’s DKIM signature', { dkim: 'gmail.com' }],
    ['a look-alike domain’s signature', { dkim: 'poshmark.com.evil.example' }],
    ['a failed SPF check', { spf: 'fail' }],
    ['verdicts from an untrusted receiver', { receiver: 'mx.attacker.example' }],
  ])('rejects a spoofed sold email with %s and never acts on it', async (_, delivery) => {
    const jacket = await item("Levi's Vintage Trucker Jacket Size M");
    await listing(jacket.id, 'poshmark', { externalListingId: POSHMARK_LISTING_ID });
    const connection = await automationConnection('poshmark');
    await db.deleteFrom('sale_check_schedule').where('connection_id', '=', connection).execute();

    expect(await receive('poshmark-sold', delivery)).toEqual({ rejected: 1 });

    expect(await sales()).toEqual([]);
    expect(await tasks()).toEqual([]);
    const [event] = await events();
    expect(event).toMatchObject({ signature_ok: false, result: 'failed' });
    expect(event?.error_message).toMatch(/^Rejected: /);
    expect(await saleCheck(connection)).toEqual({ reason: null, queued: 0 });
    const status = await db
      .selectFrom('inventory_item')
      .select('status')
      .where('id', '=', jacket.id)
      .executeTakeFirstOrThrow();
    expect(status.status).toBe('listed');
    expect(await readdir(inboxDir)).toEqual([]);
  });

  it('makes an unknown format a review task, never a delist, and asks for a sale check', async () => {
    const tee = await item('Y2K Baby Tee Butterfly Print');
    await listing(tee.id, 'depop', { externalListingId: 'janescloset-y2k-baby-tee-butterfly' });
    const connection = await automationConnection('depop');

    expect(await receive('depop-sold-new-format')).toEqual({ review_task: 1 });

    expect(await sales()).toEqual([]);
    const [task] = await tasks();
    expect(task).toMatchObject({
      kind: 'review_match',
      item_id: null,
      urgency: 'urgent',
      status: 'open',
    });
    expect(emailSaleOfTask(task?.payload)?.emailSale).toMatchObject({
      reason: 'unknown_format',
      title: null,
      priceCents: null,
      candidateItemIds: [],
    });
    expect(await saleCheck(connection)).toEqual({ reason: 'email', queued: 1 });
  });

  it('makes an ambiguous title match a review task with the candidates', async () => {
    const first = await item('Patagonia Better Sweater Fleece Jacket');
    const second = await item('Patagonia Better Sweater Fleece Jacket');
    await listing(first.id, 'poshmark');
    await listing(second.id, 'poshmark', { title: 'patagonia better-sweater fleece jacket' });

    expect(await receive('poshmark-sold-no-link')).toEqual({ review_task: 1 });

    expect(await sales()).toEqual([]);
    const [task] = await tasks();
    expect(new Set(emailSaleOfTask(task?.payload)?.emailSale.candidateItemIds)).toEqual(
      new Set([first.id, second.id]),
    );
    expect(emailSaleOfTask(task?.payload)?.emailSale).toMatchObject({
      reason: 'ambiguous_match',
      priceCents: 6200,
    });
  });

  it('matches by Listora’s SKU, then by a unique title', async () => {
    const bag = await item('Coach Leather Crossbody Bag');
    await listing(bag.id, 'mercari', { externalListingId: null });
    await db
      .updateTable('inventory_item')
      .set({ sku: 'JD-000042' })
      .where('id', '=', bag.id)
      .execute();
    const fleece = await item('Patagonia Better Sweater Fleece Jacket');
    await listing(fleece.id, 'poshmark');

    expect(await receive('mercari-sold-sku')).toEqual({ recorded: 1 });
    expect(await receive('poshmark-sold-no-link')).toEqual({ recorded: 1 });

    expect((await sales()).map((sale) => sale.item_id).sort()).toEqual([bag.id, fleece.id].sort());
  });

  it('ignores a sale email that matches no Listora listing, and a marketplace email that is no sale', async () => {
    expect(await receive('mercari-sold')).toEqual({ no_match: 1 });
    expect(await receive('poshmark-offer')).toEqual({ not_a_sale: 1 });
    expect(await sales()).toEqual([]);
    expect(await tasks()).toEqual([]);
    expect((await events()).map((event) => event.result)).toEqual(['ignored']);
  });

  it('records a sale once when the scheduled check found it first', async () => {
    const shoes = await item("Nike Air Max 90 Men's Size 10");
    const mercari = await listing(shoes.id, 'mercari', { externalListingId: 'm48213907561' });
    // What the automated sale check records: the listing id names the order.
    const checked = await recordSale(
      db,
      {
        accountId,
        marketplace: 'mercari',
        externalOrderId: 'm48213907561',
        soldAt: new Date(),
        currency: 'USD',
        shippingChargedCents: 0,
        detectionSource: 'poll',
        inboundEventId: null,
        shipBy: null,
        lines: [
          { externalListingId: 'm48213907561', externalSku: null, quantity: 1, priceCents: 3000 },
        ],
      },
      { adapters },
    );
    expect(checked.type).toBe('recorded');

    expect(await receive('mercari-sold')).toEqual({ already_recorded: 1 });

    expect(await sales()).toHaveLength(1);
    expect((await events())[0]).toMatchObject({ result: 'ignored' });
    const incidents = await db
      .selectFrom('user_task')
      .select('kind')
      .where('kind', '=', 'resolve_double_sale')
      .execute();
    expect(incidents).toEqual([]);
    expect(mercari).toBeDefined();
  });

  it('records a sale once when the email came first and the scheduled check finds it later', async () => {
    const shoes = await item("Nike Air Max 90 Men's Size 10");
    await listing(shoes.id, 'mercari', { externalListingId: 'm48213907561' });
    expect(await receive('mercari-sold')).toEqual({ recorded: 1 });

    const checked = await recordSale(
      db,
      {
        accountId,
        marketplace: 'mercari',
        externalOrderId: 'm48213907561',
        soldAt: new Date(),
        currency: 'USD',
        shippingChargedCents: 0,
        detectionSource: 'poll',
        inboundEventId: null,
        shipBy: null,
        lines: [
          { externalListingId: 'm48213907561', externalSku: null, quantity: 1, priceCents: 3000 },
        ],
      },
      { adapters },
    );
    expect(checked.type).toBe('duplicate');
    expect(await sales()).toHaveLength(1);
  });

  it('never lets a forged copy of an email block the real one', async () => {
    const jacket = await item("Levi's Vintage Trucker Jacket Size M");
    await listing(jacket.id, 'poshmark', { externalListingId: POSHMARK_LISTING_ID });
    // Same Message-ID, no marketplace signature: rejected first.
    expect(await receive('poshmark-sold', { dkim: null })).toEqual({ rejected: 1 });
    expect(await receive('poshmark-sold')).toEqual({ recorded: 1 });
    expect(await sales()).toHaveLength(1);
  });

  it('processes one email once, however often it is forwarded', async () => {
    const jacket = await item("Levi's Vintage Trucker Jacket Size M");
    await listing(jacket.id, 'poshmark', { externalListingId: POSHMARK_LISTING_ID });
    expect(await receive('poshmark-sold')).toEqual({ recorded: 1 });
    expect(await receive('poshmark-sold')).toEqual({ duplicate: 1 });
    expect(await sales()).toHaveLength(1);
  });

  it('asks before auto-delisting when the seller chose to: a confirm task, no sale yet', async () => {
    await saveAskBeforeDelist(db, accountId, true);
    const jacket = await item("Levi's Vintage Trucker Jacket Size M");
    const poshmark = await listing(jacket.id, 'poshmark', {
      externalListingId: POSHMARK_LISTING_ID,
    });
    await listing(jacket.id, 'mercari');

    expect(await receive('poshmark-sold')).toEqual({ confirm_task: 1 });

    expect(await sales()).toEqual([]);
    const [task] = await tasks();
    expect(task).toMatchObject({
      kind: 'confirm_sale',
      item_id: jacket.id,
      listing_id: poshmark,
      urgency: 'urgent',
    });
    expect(emailSaleOfTask(task?.payload)?.emailSale).toMatchObject({
      reason: 'ask_before_delist',
      priceCents: 4500,
      orderNumber: '6731f0a1c2b3d4e5f6a7b8c9',
    });
    const status = await db
      .selectFrom('inventory_item')
      .select('status')
      .where('id', '=', jacket.id)
      .executeTakeFirstOrThrow();
    expect(status.status).toBe('listed');
    const pushes = await sql<{ count: number }>`
      select count(*)::int as count from graphile_worker.jobs where key like 'push:sale_email_task:%'
    `.execute(db);
    expect(pushes.rows[0]?.count).toBeGreaterThan(0);
  });

  it('keeps the forwarding confirmation for the app, and drops mail to unknown addresses', async () => {
    const inbox = await findSaleEmailInbox(db, accountId);
    await dropInInbox(
      inboxDir,
      deliver(fixture('gmail-forwarding', inbox?.addressToken), {
        to: address,
        dkim: 'google.com',
      }),
    );
    await dropInInbox(
      inboxDir,
      deliver(fixture('poshmark-sold'), {
        to: forwardingAddress('zzzzzzzzzzzzzzzzzzzz', DOMAIN),
        dkim: 'poshmark.com',
      }),
    );
    expect(
      await runEmailIngest({
        db,
        adapters,
        logger,
        inboundDomain: DOMAIN,
        source: new FolderMailSource(inboxDir),
      }),
    ).toEqual({ confirmation: 1, undeliverable: 1 });

    expect((await findSaleEmailInbox(db, accountId))?.confirmation).toMatchObject({
      provider: 'Gmail',
      code: '418273645',
      url: expect.stringMatching(/^https:\/\/mail-settings\.google\.com\//) as string,
    });
    expect(await readdir(inboxDir)).toEqual([]);
  });

  it('never shows a confirmation link from a forged provider email', async () => {
    const inbox = await findSaleEmailInbox(db, accountId);
    await dropInInbox(
      inboxDir,
      deliver(fixture('gmail-forwarding', inbox?.addressToken), { to: address, dkim: null }),
    );
    expect(
      await runEmailIngest({
        db,
        adapters,
        logger,
        inboundDomain: DOMAIN,
        source: new FolderMailSource(inboxDir),
      }),
    ).toEqual({ rejected: 1 });
    expect((await findSaleEmailInbox(db, accountId))?.confirmation).toBeNull();
  });
});
