/**
 * Starting an import beside work on the same connections (real Postgres). A phone's claim holds
 * `lockConnections`'s key-share lock on every connection of the phone, in id order, while a
 * sync starts an import of each marketplace in its own order. With `for update` the import's
 * start waited for the claim and the claim for it: `deadlock detected` on `POST /v1/phone-runs`
 * (the personal environment, 2026-11-03). Starting an import now never waits for that lock.
 */
import { randomBytes } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  automationProfile,
  linkAutomationSession,
  type AutomatedMarketplace,
} from '@listora/automation';
import { LocalTokenVault, SessionVault } from '@listora/connections';
import { lockConnections, type Db } from '@listora/db';
import { createMigratedDatabase, insertAccount, type MigratedDatabase } from '@listora/db/testing';
import { createLogger } from '@listora/shared';

import { startListingImport } from './start.ts';

const logger = createLogger({ service: 'imports-test', level: 'silent' });

/** A promise and the function that settles it, to step two transactions in turn. */
function gate(): { opened: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

describe('starting an import beside a claim (real Postgres)', () => {
  let database: MigratedDatabase;
  let db: Db;
  let accountId: string;
  const vault = new SessionVault({ vault: new LocalTokenVault(randomBytes(32)), logger });

  beforeAll(async () => {
    database = await createMigratedDatabase('importstart', { jobQueue: true, max: 6 });
    db = database.db;
    accountId = await insertAccount(db);
  });

  afterAll(async () => {
    await database.close();
  });

  async function link(marketplace: AutomatedMarketplace): Promise<string> {
    const profile = automationProfile(marketplace);
    const { connectionId } = await linkAutomationSession(
      db,
      { vault, profile },
      {
        accountId,
        marketplace,
        runsOn: 'phone',
        cookies: [
          {
            name: 'session',
            value: 'signed-in',
            domain: profile.cookieDomains[0] ?? '.example.com',
            path: '/',
            expires: -1,
            httpOnly: true,
            secure: true,
            sameSite: 'Lax',
          },
        ],
      },
    );
    return connectionId;
  }

  it("never waits for a claim's lock on the connection, so the two can't deadlock", async () => {
    const connections = [
      { marketplace: 'depop' as const, id: await link('depop') },
      { marketplace: 'poshmark' as const, id: await link('poshmark') },
    ].sort((a, b) => (a.id < b.id ? -1 : 1));
    // The claim locks in id order; the sync starts the later one's import first.
    const [first, second] = connections as [(typeof connections)[0], (typeof connections)[0]];

    const claimHoldsFirst = gate();
    const importHoldsSecond = gate();
    const claimHoldsBoth = gate();

    const claim = db.transaction().execute(async (trx) => {
      // A wait longer than this is the bug: fail rather than hang.
      await sql`set local lock_timeout = '3s'`.execute(trx);
      await lockConnections(trx, accountId, [first.id]);
      claimHoldsFirst.open();
      await importHoldsSecond.opened;
      await lockConnections(trx, accountId, [second.id]);
      claimHoldsBoth.open();
    });
    const sync = db.transaction().execute(async (trx) => {
      await sql`set local lock_timeout = '3s'`.execute(trx);
      await claimHoldsFirst.opened;
      await startListingImport(trx, { accountId, marketplace: second.marketplace });
      importHoldsSecond.open();
      await claimHoldsBoth.opened;
      return startListingImport(trx, { accountId, marketplace: first.marketplace });
    });

    await expect(Promise.all([claim, sync])).resolves.toEqual([
      undefined,
      expect.objectContaining({ connection_id: first.id, status: 'reading' }),
    ]);
    const started = await db
      .selectFrom('listing_import')
      .select('connection_id')
      .where('account_id', '=', accountId)
      .execute();
    expect(started.map((row) => row.connection_id).sort()).toEqual([first.id, second.id].sort());
  }, 30_000);
});
