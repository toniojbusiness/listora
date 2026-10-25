/**
 * The task inbox end to end: listing on an assisted marketplace queues an operation, a real
 * operation worker turns it into a user task with copy-assist and a deep link, and only the
 * user's confirmation finishes it, as "you confirmed" and never "confirmed by <marketplace>".
 * Dismissing a task fails its operation with a Retry; nothing is ever shown as done that the
 * user did not confirm.
 */
import { jsonb } from '@listora/db';
import { createMarketplaceAdapters } from '@listora/marketplaces';
import { startOperationWorker, type OperationWorker, type RetryPolicy } from '@listora/operations';
import { createLogger } from '@listora/shared';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Tenant } from '../tenancy.ts';
import { createTestApi, fieldsOf, type SuccessBody, type TestApi } from '../test-support.ts';

const OWNER = 'tasks.owner@example.com';
const STRANGER = 'tasks.stranger@example.com';

const FAST_POLICY: RetryPolicy = {
  delaysMs: [20, 30, 40, 50, 60, 70],
  jitter: 0,
  random: () => 0.5,
};

const DETAILS = {
  title: 'Linen Button-Up Shirt',
  description: 'Relaxed linen shirt, worn twice.',
  brand: 'Everlane',
  condition: 'pre_owned_excellent',
  listPrice: { amountCents: 2800, currency: 'USD' },
} as const;

const VARIANT = {
  title: 'Everlane Linen Button-Up Shirt',
  description: 'Relaxed linen shirt in white, worn twice.',
  price: { amountCents: 2800, currency: 'USD' },
} as const;

const POSHMARK_LISTING =
  'https://poshmark.com/listing/Everlane-Linen-Shirt-64f1a2b3c4d5e6f7a8b9c0d1';

async function jpeg(seed: number): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({
      create: { width: 640, height: 480, channels: 3, background: { r: seed % 256, g: 40, b: 90 } },
    })
      .jpeg({ quality: 80 })
      .toBuffer(),
  );
}

describe('the task inbox (real Postgres, real operation worker)', () => {
  let api: TestApi;
  let worker: OperationWorker | undefined;
  let token: string;
  let tenant: Tenant;
  let seed = 0;

  beforeAll(async () => {
    const adapters = createMarketplaceAdapters({
      fakeMarketplaceUrl: undefined,
      ebay: undefined,
      depop: undefined,
    });
    api = await createTestApi('tasks', {
      connections: { adapters, oauth: {}, sealer: undefined },
    });
    token = await api.signIn(OWNER);
    tenant = await api.tenantOf(OWNER);
    worker = await startOperationWorker({
      connectionString: api.databaseUrl,
      db: api.db,
      adapters: adapters.lookup,
      logger: createLogger({ service: 'tasks-test', level: 'silent' }),
      policy: FAST_POLICY,
      pollIntervalMs: 20,
      onFatalError: (error) => {
        throw error;
      },
    });
  });

  afterAll(async () => {
    await worker?.stop();
    await api.close();
  });

  /** A ready-to-list item with three processed photos, in posting order front, back, tag. */
  async function readyItem(): Promise<SuccessBody<'createItem'>> {
    const created = await api.call('createItem', { token, body: { details: DETAILS } });
    expect(created.status).toBe(201);
    for (const role of ['front', 'back', 'tag'] as const) {
      seed += 1;
      const uploadFileId = await api.uploads.add(tenant, { bytes: await jpeg(seed) });
      const added = await api.call('addItemPhoto', {
        token,
        params: { itemId: created.body.id },
        body: { uploadFileId, role, width: 640, height: 480 },
      });
      expect(added.status).toBe(201);
    }
    await api.photoJobs.runAll();
    return created.body;
  }

  /** Waits until the listing's newest operation stops moving, then returns the listing. */
  async function settled(listingId: string) {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const listing = await api.call('getListing', { token, params: { listingId } });
      expect(listing.status).toBe(200);
      const status = listing.body.latestOperation?.status;
      if (status === 'succeeded' || status === 'failed' || status === 'needs_user_action') {
        return listing.body;
      }
      if (Date.now() > deadline) throw new Error(`listing ${listingId} never settled`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** Lists the item on Poshmark through the API and waits for the task. */
  async function listOnPoshmark() {
    const item = await readyItem();
    const draft = await api.call('createListing', {
      token,
      params: { itemId: item.id },
      body: { marketplace: 'poshmark', variant: VARIANT },
    });
    expect(draft.status).toBe(201);
    expect(draft.body.availableActions).toEqual([{ action: 'publish', mode: 'assisted' }]);
    const published = await api.call('publishListing', {
      token,
      params: { listingId: draft.body.id },
    });
    expect(published.status).toBe(202);
    const listing = await settled(draft.body.id);
    const tasks = await api.call('listTasks', {
      token,
      query: { status: ['open'], itemId: item.id },
    });
    expect(tasks.status).toBe(200);
    const [task] = tasks.body.data;
    if (task === undefined) throw new Error('no task');
    return { item, listing, task };
  }

  it('turns an assisted listing into a task with copy-assist, photos in order, and a link', async () => {
    const { item, listing, task } = await listOnPoshmark();
    expect(listing.statusDisplay).toEqual({
      tone: 'action_needed',
      label: 'Action needed - list on Poshmark',
    });
    expect(task).toMatchObject({
      kind: 'list_manually',
      status: 'open',
      urgency: 'normal',
      title: 'List on Poshmark',
      marketplace: 'poshmark',
      itemId: item.id,
      item: { id: item.id, sku: item.sku, title: DETAILS.title },
      listingId: listing.id,
      operationId: listing.latestOperation?.id,
      deepLink: 'https://poshmark.com/',
    });
    expect(task.item?.coverPhoto?.role).toBe('front');
    expect(task.copyAssist?.fields).toEqual([
      { label: 'Title', value: VARIANT.title },
      { label: 'Description', value: VARIANT.description },
      { label: 'Price', value: '28.00' },
    ]);
    expect(task.copyAssist?.photos.map((photo) => photo.role)).toEqual(['front', 'back', 'tag']);
    for (const photo of task.copyAssist?.photos ?? []) {
      expect(photo.urls?.listing).toMatch(/^http/);
    }
    // The listing waits for the user: no action is offered until the task is done.
    expect(listing.availableActions).toEqual([]);

    const fetched = await api.call('getTask', { token, params: { taskId: task.id } });
    expect(fetched.status).toBe(200);
    expect(fetched.body).toEqual(task);
  });

  it("finishes a list task only on the user's word, links the pasted URL, and then delists by task", async () => {
    const { item, listing, task } = await listOnPoshmark();

    const done = await api.call('completeTask', {
      token,
      params: { taskId: task.id },
      body: { externalUrl: `${POSHMARK_LISTING}?utm_source=pm_share` },
    });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'completed' });
    expect(done.body.completedAt).toBeDefined();

    const active = await api.call('getListing', { token, params: { listingId: listing.id } });
    expect(active.body).toMatchObject({
      status: 'active',
      mode: 'assisted',
      statusDisplay: { tone: 'success', label: 'Done (you confirmed)' },
      verification: { method: 'user_confirmation' },
      externalListingId: '64f1a2b3c4d5e6f7a8b9c0d1',
      externalUrl: POSHMARK_LISTING,
    });
    expect(JSON.stringify(active.body)).not.toMatch(/confirmed by/i);
    expect(active.body.availableActions.map((available) => available.action)).toEqual([
      'change_price',
      'revise',
      'end',
    ]);
    const listed = await api.call('getItem', { token, params: { itemId: item.id } });
    expect(listed.body.status).toBe('listed');

    // Done twice is refused, and the open list no longer has it.
    const again = await api.call('completeTask', {
      token,
      params: { taskId: task.id },
      body: {},
    });
    expect(again.status).toBe(409);
    const open = await api.call('listTasks', {
      token,
      query: { status: ['open'], itemId: item.id },
    });
    expect(open.body.data).toEqual([]);

    // Ending it is the user's step too: the task opens the listing's own page.
    const ended = await api.call('endListing', {
      token,
      params: { listingId: listing.id },
      body: { reason: 'not_available' },
    });
    expect(ended.status).toBe(202);
    const waiting = await settled(listing.id);
    expect(waiting.statusDisplay.label).toBe('Action needed - delist on Poshmark');
    const [delist] = (
      await api.call('listTasks', { token, query: { status: ['open'], itemId: item.id } })
    ).body.data;
    expect(delist).toMatchObject({
      kind: 'delist_manually',
      title: 'Delist on Poshmark',
      deepLink: POSHMARK_LISTING,
    });
    expect(delist?.copyAssist).toBeUndefined();

    const removed = await api.call('completeTask', {
      token,
      params: { taskId: delist?.id ?? '' },
      body: { note: 'Deleted it in the app' },
    });
    expect(removed.status).toBe(200);
    const gone = await api.call('getListing', { token, params: { listingId: listing.id } });
    expect(gone.body.status).toBe('ended');
    expect(gone.body.statusDisplay.label).toBe('Done (you confirmed)');
    expect(gone.body.latestOperation?.statusDisplay.label).toBe('Done (you confirmed)');
    expect(JSON.stringify(gone.body)).not.toMatch(/confirmed by/i);
  });

  it("refuses a pasted URL that is not a listing on the task's marketplace, and changes nothing", async () => {
    const { listing, task } = await listOnPoshmark();
    for (const externalUrl of [
      'https://www.mercari.com/us/item/m12345678901/',
      'https://poshmark.com/closet/someone',
      'https://example.com/listing/1',
    ]) {
      const refused = await api.call('completeTask', {
        token,
        params: { taskId: task.id },
        body: { externalUrl },
      });
      expect(refused.status, externalUrl).toBe(422);
      expect(fieldsOf(refused as { error: NonNullable<typeof refused.error> })).toEqual([
        'externalUrl',
      ]);
    }
    const wrongField = await api.call('completeTask', {
      token,
      params: { taskId: task.id },
      body: { rejectMatch: true },
    });
    expect(wrongField.status).toBe(422);
    expect(fieldsOf(wrongField as { error: NonNullable<typeof wrongField.error> })).toEqual([
      'rejectMatch',
    ]);

    const still = await api.call('getListing', { token, params: { listingId: listing.id } });
    expect(still.body.statusDisplay.label).toBe('Action needed - list on Poshmark');
    const task2 = await api.call('getTask', { token, params: { taskId: task.id } });
    expect(task2.body.status).toBe('open');
  });

  it('fails a dismissed task with a Retry that makes a new one, never counting it done', async () => {
    const { listing, task } = await listOnPoshmark();
    const dismissed = await api.call('dismissTask', { token, params: { taskId: task.id } });
    expect(dismissed.status).toBe(200);
    expect(dismissed.body.status).toBe('dismissed');

    const failed = await api.call('getListing', { token, params: { listingId: listing.id } });
    expect(failed.body.statusDisplay).toMatchObject({
      tone: 'failed',
      label: 'Publish failed - Retry',
    });
    expect(failed.body.latestOperation).toMatchObject({ status: 'failed' });
    expect(failed.body.status).not.toBe('active');

    const retried = await api.call('retryOperation', {
      token,
      params: { operationId: task.operationId ?? '' },
    });
    expect(retried.status).toBe(202);
    await settled(listing.id);
    const open = await api.call('listTasks', {
      token,
      query: { status: ['open'], itemId: task.itemId ?? '' },
    });
    expect(open.body.data).toHaveLength(1);
    expect(open.body.data[0]?.id).not.toBe(task.id);
  });

  it('finishes the open list task when the user shares the listing to the item', async () => {
    const { item, listing, task } = await listOnPoshmark();
    const linked = await api.call('linkItemListing', {
      token,
      params: { itemId: item.id },
      body: {
        url: POSHMARK_LISTING.replace('64f1a2b3c4d5e6f7a8b9c0d1', '64f1a2b3c4d5e6f7a8b9c0d2'),
      },
    });
    expect(linked.status).toBe(201);
    expect(linked.body).toMatchObject({
      id: listing.id,
      status: 'active',
      statusDisplay: { label: 'Done (you confirmed)' },
      externalListingId: '64f1a2b3c4d5e6f7a8b9c0d2',
    });
    const done = await api.call('getTask', { token, params: { taskId: task.id } });
    expect(done.body.status).toBe('completed');
  });

  it('lists urgent tasks first, then oldest first, across pages', async () => {
    const before = await api.call('listTasks', { token, query: { status: ['open'] } });
    const openIds = before.body.data.map((task) => task.id);
    const created = [await listOnPoshmark(), await listOnPoshmark(), await listOnPoshmark()];
    // A delist after a sale is urgent (the auto-delist orchestrator creates these).
    const urgentId = created[2]?.task.id ?? '';
    await api.db
      .updateTable('user_task')
      .set({ urgency: 'urgent' })
      .where('id', '=', urgentId)
      .execute();

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await api.call('listTasks', {
        token,
        query: { status: ['open'], limit: 2, ...(cursor === undefined ? {} : { cursor }) },
      });
      expect(page.status).toBe(200);
      seen.push(...page.body.data.map((task) => task.id));
      cursor = page.body.nextCursor;
    } while (cursor !== undefined);
    expect(seen).toEqual([urgentId, ...openIds, created[0]?.task.id, created[1]?.task.id]);
    const [first] = (await api.call('listTasks', { token, query: { limit: 1 } })).body.data;
    expect(first?.urgency).toBe('urgent');
  });

  it("shows a double-sale incident with its cancel steps, finished on the user's word", async () => {
    const item = await readyItem();
    const sale = await api.db
      .insertInto('sale')
      .values({
        account_id: tenant.accountId,
        marketplace: 'mercari',
        external_order_id: `double-${item.id}`,
        sold_at: new Date(),
        detection_source: 'manual',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const { id } = await api.db
      .insertInto('user_task')
      .values({
        account_id: tenant.accountId,
        kind: 'resolve_double_sale',
        item_id: item.id,
        sale_id: sale.id,
        urgency: 'urgent',
        deep_link: 'https://www.mercari.com/help_center/',
        payload: jsonb({
          title: 'Cancel the Mercari order',
          marketplace: 'mercari',
          steps: ['Open the order', 'Tap Cancel order'],
        }),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const task = await api.call('getTask', { token, params: { taskId: id } });
    expect(task.body).toMatchObject({
      kind: 'resolve_double_sale',
      urgency: 'urgent',
      title: 'Cancel the Mercari order',
      marketplace: 'mercari',
      saleId: sale.id,
      deepLink: 'https://www.mercari.com/help_center/',
    });
    expect(task.body.instructions).toContain('1. Open the order\n2. Tap Cancel order');

    const done = await api.call('completeTask', { token, params: { taskId: id }, body: {} });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('completed');
  });

  it("never shows or finishes another account's task", async () => {
    const { task } = await listOnPoshmark();
    const other = await api.signIn(STRANGER);
    expect((await api.call('getTask', { token: other, params: { taskId: task.id } })).status).toBe(
      404,
    );
    const stolen = await api.call('completeTask', {
      token: other,
      params: { taskId: task.id },
      body: {},
    });
    expect(stolen.status).toBe(404);
    expect(
      (await api.call('dismissTask', { token: other, params: { taskId: task.id } })).status,
    ).toBe(404);
    expect((await api.call('listTasks', { token: other, query: {} })).body.data).toEqual([]);
    const mine = await api.call('getTask', { token, params: { taskId: task.id } });
    expect(mine.body.status).toBe('open');
  });
});
