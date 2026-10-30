/**
 * Sync in the API (docs/features/sync.md), on real Postgres: Sync now asks for read-only checks
 * of every linked marketplace (its sales, its offers, its listings) on the phone or
 * in the cloud where it runs, never twice within minutes; a read-only connection is synced like
 * any other and nothing that could change it is queued; and the status says what each one is
 * doing and what its last sync found, in the seller's words.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Marketplace } from '@listora/db';

import { createTestApi, type TestApi } from '../test-support.ts';

describe('sync (real Postgres)', () => {
  let api: TestApi;
  let sequence = 0;

  beforeAll(async () => {
    api = await createTestApi('sync');
  });

  afterAll(async () => {
    await api.close();
  });

  /** A signed-in seller with the connections given. */
  async function seller(
    connections: { marketplace: Marketplace; runsOn: 'phone' | 'cloud'; readOnly?: boolean }[],
  ) {
    sequence += 1;
    const email = `sync.${String(sequence)}@example.com`;
    const token = await api.signIn(email);
    const tenant = await api.tenantOf(email);
    const ids: Partial<Record<Marketplace, string>> = {};
    for (const connection of connections) {
      const row = await api.db
        .insertInto('marketplace_connection')
        .values({
          account_id: tenant.accountId,
          marketplace: connection.marketplace,
          mode: 'automation',
          status: 'connected',
          token_ciphertext: Buffer.from('sealed'),
          runs_on: connection.runsOn,
          read_only: connection.readOnly ?? false,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      ids[connection.marketplace] = row.id;
    }
    const accountId = tenant.accountId;
    const phoneWork = async () =>
      (
        await api.db
          .selectFrom('phone_work')
          .select(['marketplace', 'purpose'])
          .where('account_id', '=', accountId)
          .orderBy('marketplace')
          .orderBy('purpose')
          .execute()
      ).map((row) => `${row.marketplace}:${row.purpose}`);
    return { token, accountId, ids, phoneWork };
  }

  it('asks for read-only checks of every linked marketplace, where each runs, and says what it is doing', async () => {
    const { token, accountId, ids, phoneWork } = await seller([
      { marketplace: 'depop', runsOn: 'phone' },
      { marketplace: 'mercari', runsOn: 'cloud' },
    ]);
    const before = await api.call('getSyncStatus', { token });
    expect(before.body.data).toEqual([
      { marketplace: 'depop', state: 'not_synced', statusText: 'Not synced yet', readOnly: false },
      {
        marketplace: 'mercari',
        state: 'not_synced',
        statusText: 'Not synced yet',
        readOnly: false,
      },
    ]);

    const synced = await api.call('requestSync', { token });
    expect(synced.status).toBe(200);
    expect(synced.body.data).toEqual([
      { marketplace: 'depop', state: 'syncing', statusText: 'Checking sales...', readOnly: false },
      {
        marketplace: 'mercari',
        state: 'syncing',
        statusText: 'Checking sales...',
        readOnly: false,
      },
    ]);
    // Depop runs on the phone: its sale check, offer read, and listings (never imported: the
    // first import) wait there. Mercari runs in the cloud: its sale check is the runner's job
    // (Mercari's offers are not read).
    expect(await phoneWork()).toEqual([
      'depop:listing_import',
      'depop:offer_check',
      'depop:sale_check',
    ]);
    const { rows } = await sql<{ key: string }>`
      select key from graphile_worker.jobs where key = ${`sale-check:${ids.mercari ?? ''}`}
    `.execute(api.db);
    expect(rows).toHaveLength(1);
    const schedule = await api.db
      .selectFrom('sale_check_schedule')
      .select(['marketplace', 'next_reason'])
      .where('account_id', '=', accountId)
      .orderBy('marketplace')
      .execute();
    expect(schedule).toEqual([
      { marketplace: 'depop', next_reason: 'sync' },
      { marketplace: 'mercari', next_reason: 'sync' },
    ]);

    // Synced again while the reads wait: nothing more is queued.
    await api.call('requestSync', { token });
    expect(await phoneWork()).toEqual([
      'depop:listing_import',
      'depop:offer_check',
      'depop:sale_check',
    ]);
  });

  it('does not read a marketplace again within 2 minutes of its last check', async () => {
    const { token, accountId, phoneWork } = await seller([
      { marketplace: 'depop', runsOn: 'phone' },
    ]);
    await api.call('requestSync', { token });
    // The phone ran both reads.
    await api.db.deleteFrom('phone_work').where('account_id', '=', accountId).execute();
    await api.db
      .updateTable('sale_check_schedule')
      .set({ last_started_at: sql<Date>`now()` })
      .where('account_id', '=', accountId)
      .execute();
    await api.call('requestSync', { token });
    expect(await phoneWork()).toEqual([]);

    await api.db
      .updateTable('sale_check_schedule')
      .set({ last_started_at: sql<Date>`now() - interval '3 minutes'` })
      .where('account_id', '=', accountId)
      .execute();
    await api.db
      .updateTable('offer_check')
      .set({ requested_at: sql<Date>`now() - interval '3 minutes'` })
      .where('account_id', '=', accountId)
      .execute();
    await api.call('requestSync', { token });
    expect(await phoneWork()).toEqual(['depop:offer_check', 'depop:sale_check']);
  });

  it('syncs a read-only account like any other and queues nothing that could change it', async () => {
    const { token, accountId, phoneWork } = await seller([
      { marketplace: 'depop', runsOn: 'phone', readOnly: true },
    ]);
    const synced = await api.call('requestSync', { token });
    expect(synced.body.data).toEqual([
      { marketplace: 'depop', state: 'syncing', statusText: 'Checking sales...', readOnly: true },
    ]);
    expect(await phoneWork()).toEqual([
      'depop:listing_import',
      'depop:offer_check',
      'depop:sale_check',
    ]);
    const operations = await api.db
      .selectFrom('marketplace_operation')
      .select('id')
      .where('account_id', '=', accountId)
      .execute();
    expect(operations).toEqual([]);
  });

  it('reads the listings on every sync: the first import when none ran, then again once the last one finished', async () => {
    const { token, accountId, phoneWork } = await seller([
      { marketplace: 'depop', runsOn: 'phone' },
    ]);
    const imports = () =>
      api.db
        .selectFrom('listing_import')
        .select(['status'])
        .where('account_id', '=', accountId)
        .orderBy('created_at')
        .execute();
    // Never imported (linked before linking imported): the sync imports.
    await api.call('requestSync', { token });
    expect(await imports()).toEqual([{ status: 'reading' }]);

    // While it reads, a sync reads nothing more of the listings.
    await api.db.deleteFrom('phone_work').where('account_id', '=', accountId).execute();
    await api.db.deleteFrom('sale_check_schedule').where('account_id', '=', accountId).execute();
    await api.db.deleteFrom('offer_check').where('account_id', '=', accountId).execute();
    await api.call('requestSync', { token });
    expect(await imports()).toEqual([{ status: 'reading' }]);
    expect(await phoneWork()).toEqual(['depop:offer_check', 'depop:sale_check']);

    // Finished 3 minutes ago: the next sync reads them again (a read of the listings Listora
    // has takes its list pages only).
    const finish = (ago: string) =>
      sql`
      update listing_import set status = 'finished', read_at = now() - ${ago}::interval,
        created_at = now() - ${ago}::interval, finished_at = now() - ${ago}::interval
      where account_id = ${accountId} and status = 'reading'
    `.execute(api.db);
    await finish('3 minutes');
    await api.db.deleteFrom('phone_work').where('account_id', '=', accountId).execute();
    await api.db.deleteFrom('sale_check_schedule').where('account_id', '=', accountId).execute();
    await api.db.deleteFrom('offer_check').where('account_id', '=', accountId).execute();
    await api.call('requestSync', { token });
    expect(await imports()).toEqual([{ status: 'finished' }, { status: 'reading' }]);
    expect(await phoneWork()).toEqual([
      'depop:listing_import',
      'depop:offer_check',
      'depop:sale_check',
    ]);

    // One that finished within the last 2 minutes is not read again.
    await finish('0 seconds');
    await api.db.deleteFrom('phone_work').where('account_id', '=', accountId).execute();
    await api.call('requestSync', { token });
    expect(await imports()).toHaveLength(2);
  });

  it('says what the last sync found, and a failure in words the seller can act on', async () => {
    const { token, accountId, ids } = await seller([
      { marketplace: 'depop', runsOn: 'phone' },
      { marketplace: 'poshmark', runsOn: 'phone' },
    ]);
    const succeededAt = new Date('2026-10-28T12:00:00.000Z');
    await api.db
      .insertInto('sale_check_schedule')
      .values([
        {
          account_id: accountId,
          connection_id: ids.depop ?? '',
          marketplace: 'depop',
          next_check_at: new Date(),
          next_reason: 'scheduled',
          last_succeeded_at: succeededAt,
        },
        {
          account_id: accountId,
          connection_id: ids.poshmark ?? '',
          marketplace: 'poshmark',
          next_check_at: new Date(),
          next_reason: 'scheduled',
        },
      ])
      .execute();
    const run = (marketplace: 'depop' | 'poshmark', fields: Record<string, unknown>) =>
      api.db
        .insertInto('sale_check_run')
        .values({
          account_id: accountId,
          connection_id: ids[marketplace] ?? '',
          marketplace,
          kind: 'scheduled',
          reason: 'sync',
          host: 'phone',
          finished_at: sql<Date>`now()`,
          ...fields,
        })
        .execute();
    // Depop's first check read its whole sales history; Poshmark's failed.
    await run('depop', {
      outcome: 'succeeded',
      since: null,
      orders_seen: 52,
      items_seen: 52,
      new_orders: 52,
    });
    await run('poshmark', {
      outcome: 'failed',
      error_code: 'automation_step_failed',
      error_message: 'Poshmark showed a page Listora does not know.',
    });
    await api.db
      .insertInto('offer_check')
      .values({
        account_id: accountId,
        connection_id: ids.depop ?? '',
        marketplace: 'depop',
        last_outcome: 'succeeded',
        last_succeeded_at: new Date('2026-10-28T11:00:00.000Z'),
        offers_seen: 1,
      })
      .execute();

    const status = await api.call('getSyncStatus', { token });
    expect(status.body.data).toEqual([
      {
        marketplace: 'depop',
        state: 'synced',
        statusText: '52 sales found, 1 offer waiting',
        lastSyncedAt: succeededAt.toISOString(),
        readOnly: false,
      },
      {
        marketplace: 'poshmark',
        state: 'failed',
        // No internal code or diagnostic reaches the seller.
        statusText: "Couldn't check sales. Sync again to try again.",
        readOnly: false,
      },
    ]);

    // A later check that found nothing new.
    await run('depop', {
      outcome: 'succeeded',
      since: sql<Date>`now() - interval '1 hour'`,
      orders_seen: 3,
      items_seen: 3,
      new_orders: 0,
      started_at: sql<Date>`now() + interval '1 second'`,
    });
    const later = await api.call('getSyncStatus', { token });
    expect(later.body.data[0]?.statusText).toBe('No new sales, 1 offer waiting');
  });

  it('shows another account nothing', async () => {
    const owner = await seller([{ marketplace: 'depop', runsOn: 'phone' }]);
    await api.call('requestSync', { token: owner.token });
    const stranger = await seller([]);
    const status = await api.call('getSyncStatus', { token: stranger.token });
    expect(status.body.data).toEqual([]);
    expect(await stranger.phoneWork()).toEqual([]);
  });
});
