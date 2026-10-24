import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createInventoryItem } from './items.ts';
import { allocateSku, SkuAllocationError } from './sku.ts';
import { createMigratedDatabase, insertAccount, type MigratedDatabase } from './test-support.ts';

function expectedSkus(prefix: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `${prefix}-${String(index + 1).padStart(6, '0')}`,
  );
}

async function skusOf(database: MigratedDatabase, accountId: string): Promise<string[]> {
  const rows = await database.db
    .selectFrom('inventory_item')
    .select('sku')
    .where('account_id', '=', accountId)
    .orderBy('sku')
    .execute();
  return rows.map((row) => row.sku);
}

describe('SKU allocation (real Postgres)', () => {
  let database: MigratedDatabase;

  beforeAll(async () => {
    // A pool of 20 connections, so creates genuinely run concurrently and contend.
    database = await createMigratedDatabase('sku', { max: 20 });
  });

  afterAll(async () => {
    await database.close();
  });

  it('gives 100 concurrent creates per account unique, gapless SKUs', async () => {
    const first = await insertAccount(database.db, 'AJ');
    const second = await insertAccount(database.db, 'BK');

    const creates = Array.from({ length: 100 }, (_, index) => [
      createInventoryItem(database.db, first, { title: `first ${String(index)}` }),
      createInventoryItem(database.db, second, { title: `second ${String(index)}` }),
    ]).flat();
    const items = await Promise.all(creates);

    expect(new Set(items.map((item) => item.sku)).size).toBe(200);
    expect(await skusOf(database, first)).toEqual(expectedSkus('AJ', 100));
    expect(await skusOf(database, second)).toEqual(expectedSkus('BK', 100));
    const counters = await database.db
      .selectFrom('sku_sequence')
      .select(['account_id', 'next_number'])
      .where('account_id', 'in', [first, second])
      .execute();
    expect(counters.map((counter) => counter.next_number)).toEqual([101, 101]);
  });

  it('returns the number when the creating transaction rolls back', async () => {
    const account = await insertAccount(database.db, 'RB');
    await createInventoryItem(database.db, account);

    await expect(
      database.db.transaction().execute(async (trx) => {
        expect(await allocateSku(trx, account)).toBe('RB-000002');
        throw new Error('the item create failed after allocating');
      }),
    ).rejects.toThrow('the item create failed after allocating');

    // An insert rejected by a constraint also leaves no gap.
    await expect(createInventoryItem(database.db, account, { quantity: -1 })).rejects.toThrow(
      /inventory_item_quantity_check/,
    );

    expect((await createInventoryItem(database.db, account)).sku).toBe('RB-000002');
    expect(await skusOf(database, account)).toEqual(expectedSkus('RB', 2));
  });

  it('joins the caller transaction, so the item and SKU commit or roll back together', async () => {
    const account = await insertAccount(database.db, 'TX');
    await expect(
      database.db.transaction().execute(async (trx) => {
        await createInventoryItem(trx, account, { title: 'rolled back' });
        throw new Error('later step failed');
      }),
    ).rejects.toThrow('later step failed');

    expect(await skusOf(database, account)).toEqual([]);
    expect((await createInventoryItem(database.db, account)).sku).toBe('TX-000001');
  });

  it('uses the current prefix and keeps counting when the account prefix changes', async () => {
    const account = await insertAccount(database.db, 'OLD');
    await createInventoryItem(database.db, account);
    await database.db
      .updateTable('account')
      .set({ sku_prefix: 'NEW' })
      .where('id', '=', account)
      .execute();

    expect((await createInventoryItem(database.db, account)).sku).toBe('NEW-000002');
  });

  it('fails clearly once all 6-digit numbers are used', async () => {
    const account = await insertAccount(database.db, 'FUL');
    await sql`update sku_sequence set next_number = 999999 where account_id = ${account}`.execute(
      database.db,
    );

    expect((await createInventoryItem(database.db, account)).sku).toBe('FUL-999999');
    const error = await createInventoryItem(database.db, account).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(SkuAllocationError);
    expect((error as Error).message).toBe(`Account ${account} has used all 999999 SKU numbers`);
  });

  it('rejects an unknown account', async () => {
    await expect(
      createInventoryItem(database.db, '00000000-0000-7000-8000-000000000000'),
    ).rejects.toThrow(SkuAllocationError);
  });

  it('creates the counter with the account, starting at 1', async () => {
    const account = await insertAccount(database.db, 'NC');
    const counter = await database.db
      .selectFrom('sku_sequence')
      .select('next_number')
      .where('account_id', '=', account)
      .executeTakeFirstOrThrow();
    expect(counter.next_number).toBe(1);
  });
});
