/**
 * Background read health on real Postgres: offer checks and listing imports record whether they
 * worked, and the owner's alert task emails once per run of failures at either threshold, skips
 * reads Listora's pacing put off and connections only the seller can fix, and tries again when a
 * send fails. Sale checks' own path, through the runner and the fake site, is in
 * sale-checks.int.test.ts.
 */
import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { LocalTokenVault, SessionVault } from '@listora/connections';
import { createMigratedDatabase, insertAccount, type MigratedDatabase } from '@listora/db/testing';

import { AutomationReadError } from '../adapter/automation-adapter.ts';
import {
  recordImportPage,
  recordImportPageFailure,
  type PreparedImportPage,
} from '../imports/read.ts';
import { recordOfferCheckFailure, recordOffers } from '../offers/record.ts';
import { silentLogger } from '../test-support.ts';
import {
  recordReadFailed,
  runReadAlerts,
  type OwnerEmail,
  type ReadAlertDependencies,
} from './health.ts';

const HOUR = 3_600_000;
const SETTINGS = { alertAfterFailures: 3, noSuccessMs: 24 * HOUR };

describe('background read health (real Postgres)', () => {
  let database: MigratedDatabase;
  let accountId: string;
  let connectionId: string;
  const vault = new SessionVault({
    vault: new LocalTokenVault(randomBytes(32)),
    logger: silentLogger,
  });
  let sent: OwnerEmail[];
  let failSends: boolean;
  const mailer = {
    send: (email: OwnerEmail) => {
      if (failSends) return Promise.reject(new Error('SES is down'));
      sent.push(email);
      return Promise.resolve();
    },
  };
  const alerts = (overrides: Partial<ReadAlertDependencies> = {}) =>
    runReadAlerts({
      db: database.db,
      settings: SETTINGS,
      mailer,
      environment: 'test',
      logger: silentLogger,
      ...overrides,
    });

  beforeAll(async () => {
    database = await createMigratedDatabase('read_health', { jobQueue: true });
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    sent = [];
    failSends = false;
    accountId = await insertAccount(database.db);
    ({ connectionId } = await vault.linkSession(database.db, {
      accountId,
      marketplace: 'poshmark',
      cookies: [
        {
          name: 'session',
          value: randomBytes(8).toString('hex'),
          domain: '.poshmark.com',
          path: '/',
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        },
      ],
      cookieDomains: ['poshmark.com'],
    }));
    // Every alert from an earlier test is settled, so each test sees only its own.
    await database.db
      .updateTable('background_read_health')
      .set({ owner_alerted_at: new Date() })
      .where('owner_alerted_at', 'is', null)
      .execute();
  });

  const target = () => ({ accountId, connectionId, marketplace: 'poshmark' as const });
  const offersFailed = (code = 'element_missing') =>
    recordOfferCheckFailure(
      database.db,
      target(),
      new AutomationReadError(
        code,
        'read the offers',
        `Listora couldn't read offers on Poshmark (${code}).`,
        "Poshmark's offers page has no offer list (ul.offers).",
      ),
      silentLogger,
    );
  const health = (read: 'offer_check' | 'listing_import' = 'offer_check') =>
    database.db
      .selectFrom('background_read_health')
      .selectAll()
      .where('account_id', '=', accountId)
      .where('connection_id', '=', connectionId)
      .where('read', '=', read)
      .executeTakeFirst();

  it('emails the owner once at the third failed offer check, and again only after one works', async () => {
    await offersFailed();
    await offersFailed();
    expect(await alerts()).toEqual({ alerted: 0, failed: 0 });
    await offersFailed();
    expect(await health()).toMatchObject({
      marketplace: 'poshmark',
      failures_in_a_row: 3,
      last_error_code: 'element_missing',
      last_error_step: 'read the offers',
      last_error_detail: "Poshmark's offers page has no offer list (ul.offers).",
    });
    expect(await alerts()).toEqual({ alerted: 1, failed: 0 });
    expect(sent.map((email) => email.subject)).toEqual([
      '[Listora test] Poshmark offer check failed 3 times in a row',
    ]);
    expect(sent[0]?.text).toContain('Step: read the offers');
    expect(sent[0]?.text).toContain(
      "Reader's words: Poshmark's offers page has no offer list (ul.offers).",
    );
    expect(sent[0]?.text).not.toMatch(/has changed/);
    await offersFailed();
    expect(await alerts()).toEqual({ alerted: 0, failed: 0 });

    await recordOffers(database.db, target(), [], silentLogger);
    const recovered = await health();
    expect(recovered).toMatchObject({
      failures_in_a_row: 0,
      failing_since: null,
      owner_alerted_at: null,
      // The last failure stays for the admin view.
      last_error_code: 'element_missing',
    });
    expect(recovered?.last_succeeded_at).toBeInstanceOf(Date);

    for (let i = 0; i < 3; i += 1) await offersFailed('server_error');
    expect(await alerts()).toEqual({ alerted: 1, failed: 0 });
    expect(sent).toHaveLength(2);
    expect(sent[1]?.text).toContain('Last error: server_error');
  });

  it('emails the owner when a failing read has not worked for 24 hours', async () => {
    await recordOffers(database.db, target(), [], silentLogger);
    await offersFailed('step_timeout');
    expect(await alerts({ now: () => Date.now() + 23 * HOUR })).toMatchObject({ alerted: 0 });
    expect(await alerts({ now: () => Date.now() + 25 * HOUR })).toMatchObject({ alerted: 1 });
    expect(sent[0]?.subject).toBe(
      '[Listora test] Poshmark offer check has not worked for 25 hours',
    );
  });

  it("never counts a read Listora's own pacing put off", async () => {
    for (let i = 0; i < 5; i += 1) await offersFailed('automation_paced');
    await offersFailed('automation_busy');
    expect(await health()).toBeUndefined();
    expect(await alerts()).toEqual({ alerted: 0, failed: 0 });
  });

  it('leaves a connection only the seller can fix to its reconnect card', async () => {
    for (let i = 0; i < 3; i += 1) await offersFailed('session_rejected');
    await database.db
      .updateTable('marketplace_connection')
      .set({
        status: 'reauth_required',
        token_ciphertext: null,
        last_error: 'Poshmark signed Listora out.',
        last_error_code: 'session_rejected',
        last_error_at: new Date(),
      })
      .where('account_id', '=', accountId)
      .where('id', '=', connectionId)
      .execute();
    expect(await alerts()).toEqual({ alerted: 0, failed: 0 });
  });

  it('tries again next round when the email could not be sent, and never marks it sent', async () => {
    for (let i = 0; i < 3; i += 1) await offersFailed();
    failSends = true;
    expect(await alerts()).toEqual({ alerted: 0, failed: 1 });
    expect((await health())?.owner_alerted_at).toBeNull();
    failSends = false;
    expect(await alerts()).toEqual({ alerted: 1, failed: 0 });
    expect((await health())?.owner_alerted_at).toBeInstanceOf(Date);
  });

  it('records whether each page of a listing import was read', async () => {
    const page = async (): Promise<PreparedImportPage> => {
      // One import runs at a time: the one before has finished.
      await database.db
        .updateTable('listing_import')
        .set({ status: 'finished', read_at: new Date(), finished_at: new Date() })
        .where('account_id', '=', accountId)
        .execute();
      const { id } = await database.db
        .insertInto('listing_import')
        .values({
          account_id: accountId,
          connection_id: connectionId,
          marketplace: 'poshmark',
          host: 'runner',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return {
        key: { accountId, importId: id },
        marketplace: 'poshmark',
        connection: { id: connectionId, mode: 'automation', status: 'connected' },
        // Recording a page never calls the adapter.
        adapter: undefined as never,
        connectionId,
        cursor: null,
        runsOn: 'cloud',
      };
    };
    const deps = { db: database.db, logger: silentLogger };
    await recordImportPageFailure(
      deps,
      await page(),
      new AutomationReadError('automation_paced', null, 'Listora will read again shortly.'),
    );
    expect(await health('listing_import')).toBeUndefined();
    await recordImportPageFailure(
      deps,
      await page(),
      new AutomationReadError(
        'element_missing',
        'read the closet page',
        "Listora couldn't read listings on Poshmark (element_missing).",
        "Poshmark's closet page has no listing grid (div.tiles).",
      ),
    );
    expect(await health('listing_import')).toMatchObject({
      failures_in_a_row: 1,
      last_error_step: 'read the closet page',
      last_error_detail: "Poshmark's closet page has no listing grid (div.tiles).",
    });
    await recordImportPage(deps, await page(), { listings: [], next: null });
    expect(await health('listing_import')).toMatchObject({ failures_in_a_row: 0 });
  });

  it("keeps each read's health apart, and Listora's own failures with their words", async () => {
    const read = { ...target(), read: 'listing_import' as const };
    await recordReadFailed(database.db, read, {
      code: 'error',
      step: null,
      detail: 'TypeError: listings is not iterable',
    });
    expect(await health('listing_import')).toMatchObject({
      failures_in_a_row: 1,
      last_error_code: 'error',
      last_error_step: null,
      last_error_detail: 'TypeError: listings is not iterable',
    });
    expect(await health('offer_check')).toBeUndefined();
  });
});
