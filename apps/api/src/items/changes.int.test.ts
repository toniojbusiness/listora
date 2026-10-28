/**
 * The item screen's wait for a change (`waitForItemChange`): it answers at once without a
 * token, the moment an operation of the item changes (heard through `item_change`), and only
 * after `waitSeconds` when nothing changed; another item's change never ends it.
 */
import { jsonb } from '@listora/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Tenant } from '../tenancy.ts';
import { createTestApi, type TestApi } from '../test-support.ts';
import { itemOperationsToken, waitForItemChange } from './changes.ts';

const OWNER = 'changes.owner@example.com';
const STRANGER = 'changes.stranger@example.com';

describe('waitForItemChange (real Postgres)', () => {
  let api: TestApi;
  let token: string;
  let tenant: Tenant;

  beforeAll(async () => {
    api = await createTestApi('item_changes');
    token = await api.signIn(OWNER);
    tenant = await api.tenantOf(OWNER);
  });

  afterAll(async () => {
    await api.close();
  });

  /** An item with a Poshmark listing whose create operation waits for the phone. */
  async function itemWithWork(): Promise<{ itemId: string; operationId: string }> {
    const created = await api.call('createItem', { token, body: { details: { title: 'Fleece' } } });
    expect(created.status).toBe(201);
    const listing = await api.db
      .insertInto('marketplace_listing')
      .values({
        account_id: tenant.accountId,
        item_id: created.body.id,
        marketplace: 'poshmark',
        status: 'draft',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const operation = await api.db
      .insertInto('marketplace_operation')
      .values({
        account_id: tenant.accountId,
        listing_id: listing.id,
        kind: 'create',
        idempotency_key: `create-${listing.id}`,
        desired: jsonb({ status: 'active' }),
        content: jsonb({}),
        origin: 'user',
        status: 'running',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { itemId: created.body.id, operationId: operation.id };
  }

  async function wait(itemId: string, after: string | undefined, waitSeconds: number) {
    const answer = await api.call('waitForItemChange', {
      token,
      params: { itemId },
      query: { waitSeconds, ...(after === undefined ? {} : { after }) },
    });
    expect(answer.status).toBe(200);
    return answer.body;
  }

  it('answers at once without a token, and with the same token when nothing changed', async () => {
    const { itemId } = await itemWithWork();
    const first = await wait(itemId, undefined, 20);
    expect(first.changed).toBe(true);
    const started = Date.now();
    const second = await wait(itemId, first.token, 1);
    expect(second).toEqual({ changed: false, token: first.token });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it("ends the moment the item's operation changes, and not for another item's", async () => {
    const { itemId, operationId } = await itemWithWork();
    const other = await itemWithWork();
    const { token: after } = await wait(itemId, undefined, 20);
    const started = Date.now();
    const waiting = wait(itemId, after, 20);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await api.db
      .updateTable('marketplace_operation')
      .set({ status: 'verifying' })
      .where('id', '=', other.operationId)
      .execute();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await api.db
      .updateTable('marketplace_operation')
      .set({ status: 'retrying', attempts: 1, next_attempt_at: new Date(Date.now() + 60_000) })
      .where('id', '=', operationId)
      .execute();
    const answer = await waiting;
    expect(answer.changed).toBe(true);
    expect(answer.token).not.toBe(after);
    expect(answer.token).toBe(await itemOperationsToken(api.db, tenant, itemId));
    // Heard through the signal, not found by looking every few seconds.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('answers changed when the item changed before the wait began', async () => {
    const { itemId, operationId } = await itemWithWork();
    const { token: after } = await wait(itemId, undefined, 20);
    await api.db
      .updateTable('marketplace_operation')
      .set({ status: 'verifying' })
      .where('id', '=', operationId)
      .execute();
    const started = Date.now();
    expect((await wait(itemId, after, 20)).changed).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('still sees a change without signals, by looking on its schedule', async () => {
    const { itemId, operationId } = await itemWithWork();
    const after = await itemOperationsToken(api.db, tenant, itemId);
    const waiting = waitForItemChange(undefined, api.db, tenant, itemId, { after, maxMs: 10_000 });
    await api.db
      .updateTable('marketplace_operation')
      .set({ status: 'verifying' })
      .where('id', '=', operationId)
      .execute();
    expect((await waiting).changed).toBe(true);
  });

  it('ends when the app gives up on it', async () => {
    const { itemId } = await itemWithWork();
    const after = await itemOperationsToken(api.db, tenant, itemId);
    const gone = new AbortController();
    const started = Date.now();
    const waiting = waitForItemChange(undefined, api.db, tenant, itemId, {
      after,
      maxMs: 10_000,
      signal: gone.signal,
    });
    gone.abort();
    expect(await waiting).toEqual({ changed: false, token: after });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("is 404 for another account's item", async () => {
    const { itemId } = await itemWithWork();
    const stranger = await api.signIn(STRANGER);
    const answer = await api.call('waitForItemChange', {
      token: stranger,
      params: { itemId },
      query: { waitSeconds: 1 },
    });
    expect(answer.status).toBe(404);
  });
});
