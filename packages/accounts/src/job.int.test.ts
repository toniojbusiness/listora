import { randomUUID } from 'node:crypto';

import { createMigratedDatabase, type MigratedDatabase } from '@listora/db/testing';
import { createLogger } from '@listora/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startAccountDeletion, type AccountDeletionRequest } from './deletion.ts';
import { isIdentityDeleted, subjectSha256, type IdentityKey } from './identity.ts';
import {
  accountDeletionTask,
  completeAccountDeletion,
  type AccountDeletionDependencies,
  type AccountDeletionPolicy,
} from './job.ts';
import { accountDeletionJobs, FakeCognitoUserAdmin, FakeMarketplaceAccess } from './testing.ts';

const POLICY: AccountDeletionPolicy = {
  delaysMs: [60_000, 300_000],
  revocationWindowMs: 7 * 86_400_000,
};

describe('account deletion job (real Postgres)', () => {
  let database: MigratedDatabase;

  beforeAll(async () => {
    database = await createMigratedDatabase('accounts', { jobQueue: true });
  });

  afterAll(async () => {
    await database.close();
  });

  interface Harness extends AccountDeletionDependencies {
    cognito: FakeCognitoUserAdmin;
    marketplaceAccess: FakeMarketplaceAccess;
    logs: Record<string, unknown>[];
  }

  function harness(overrides: Partial<AccountDeletionDependencies> = {}): Harness {
    const logs: Record<string, unknown>[] = [];
    return {
      db: database.db,
      cognito: new FakeCognitoUserAdmin(),
      marketplaceAccess: new FakeMarketplaceAccess(),
      logger: createLogger({
        service: 'accounts-test',
        level: 'info',
        destination: {
          write: (line: string) => logs.push(JSON.parse(line) as Record<string, unknown>),
        },
      }),
      policy: POLICY,
      logs,
      ...overrides,
    } as Harness;
  }

  function cognitoIdentity(): AccountDeletionRequest['identity'] {
    const sub = randomUUID();
    return { provider: 'cognito', subject: sub, username: `signinwithapple_${sub}` };
  }

  async function start(
    identity: AccountDeletionRequest['identity'],
    grants: AccountDeletionRequest['grants'] = [],
  ): Promise<string> {
    const { deletionId } = await database.db
      .transaction()
      .execute((trx) => startAccountDeletion(trx, { identity, grants }));
    return deletionId;
  }

  function tombstone(deletionId: string) {
    return database.db
      .selectFrom('account_deletion')
      .selectAll()
      .where('id', '=', deletionId)
      .executeTakeFirst();
  }

  function grants(deletionId: string) {
    return database.db
      .selectFrom('account_deletion_grant')
      .select(['connection_id', 'outcome', 'token_ciphertext'])
      .where('deletion_id', '=', deletionId)
      .orderBy('connection_id')
      .execute();
  }

  async function jobOf(deletionId: string) {
    return (await accountDeletionJobs(database.db)).find((job) => job.deletionId === deletionId);
  }

  /** A token issued `offsetSeconds` from now. */
  function tokenOf(identity: IdentityKey, offsetSeconds: number) {
    return { ...identity, issuedAt: Math.floor(Date.now() / 1000) + offsetSeconds };
  }

  it('leaves the tombstone and its job with the deletion, or neither when it rolls back', async () => {
    const identity = cognitoIdentity();
    await expect(
      database.db.transaction().execute(async (trx) => {
        await startAccountDeletion(trx, { identity, grants: [] });
        throw new Error('the deletion failed');
      }),
    ).rejects.toThrow('the deletion failed');
    const hash = subjectSha256(identity.subject);
    const left = await database.db
      .selectFrom('account_deletion')
      .select('id')
      .where('auth_subject_sha256', '=', hash)
      .execute();
    expect(left).toEqual([]);
    expect(await isIdentityDeleted(database.db, tokenOf(identity, -60))).toBe(false);

    const deletionId = await start(identity);
    expect(await tombstone(deletionId)).toMatchObject({
      auth_provider: 'cognito',
      provider_username: identity.username,
      identity_deleted_at: null,
      attempts: 0,
    });
    expect((await jobOf(deletionId))?.runAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('deletes the Cognito user, then refuses only tokens issued before, and purges the tombstone', async () => {
    const deps = harness();
    const identity = cognitoIdentity();
    const deletionId = await start(identity);
    // Until Cognito deleted the user, even a token it issues later is refused.
    expect(await isIdentityDeleted(database.db, tokenOf(identity, 60))).toBe(true);

    expect(await completeAccountDeletion(deps, deletionId)).toBe('completed');
    expect(deps.cognito.deleted).toEqual([identity.username]);
    expect(await tombstone(deletionId)).toBeUndefined();
    expect(await isIdentityDeleted(database.db, tokenOf(identity, -1))).toBe(true);
    expect(await isIdentityDeleted(database.db, tokenOf(identity, 2))).toBe(false);
    expect(deps.logs).toContainEqual(
      expect.objectContaining({ msg: 'account deletion completed', accountDeletionId: deletionId }),
    );

    // Running it again is harmless.
    expect(await completeAccountDeletion(deps, deletionId)).toBe('not_found');
    expect(deps.cognito.deleted).toHaveLength(1);
  });

  it('retries a Cognito failure later and later, until Cognito deletes the user', async () => {
    const deps = harness();
    const identity = cognitoIdentity();
    const deletionId = await start(identity);
    deps.cognito.failWith = new Error('TooManyRequestsException');

    const before = Date.now();
    expect(await completeAccountDeletion(deps, deletionId)).toBe('retrying');
    expect(await tombstone(deletionId)).toMatchObject({ identity_deleted_at: null, attempts: 1 });
    const first = (await jobOf(deletionId))?.runAt.getTime() ?? 0;
    expect(first).toBeGreaterThanOrEqual(before + 60_000);
    expect(first).toBeLessThan(Date.now() + 61_000);

    expect(await completeAccountDeletion(deps, deletionId)).toBe('retrying');
    expect((await jobOf(deletionId))?.runAt.getTime()).toBeGreaterThanOrEqual(before + 300_000);
    expect(await isIdentityDeleted(database.db, tokenOf(identity, 60))).toBe(true);

    deps.cognito.failWith = undefined;
    expect(await completeAccountDeletion(deps, deletionId)).toBe('completed');
    expect(deps.cognito.deleted).toEqual([identity.username]);
  });

  it('waits, logging an error, while the worker has no user pool', async () => {
    const deps = harness({ cognito: undefined });
    const deletionId = await start(cognitoIdentity());

    expect(await completeAccountDeletion(deps, deletionId)).toBe('retrying');
    expect(deps.logs).toContainEqual(
      expect.objectContaining({
        level: 50,
        msg: 'cannot delete the Cognito user: the worker has no COGNITO_USER_POOL_ID',
      }),
    );
    expect(await tombstone(deletionId)).toMatchObject({ identity_deleted_at: null });
  });

  it('finishes after a crash between deleting the Cognito user and recording it', async () => {
    const deps = harness();
    const identity = cognitoIdentity();
    const deletionId = await start(identity);
    await failUpdatesOf('account_deletion');
    try {
      await expect(completeAccountDeletion(deps, deletionId)).rejects.toThrow(/simulated/);
      expect(deps.cognito.deleted).toEqual([identity.username]);
      expect(await tombstone(deletionId)).toMatchObject({ identity_deleted_at: null });
    } finally {
      await restoreUpdatesOf('account_deletion');
    }
    // The rerun asks Cognito again, which answers for a user that is already gone.
    expect(await completeAccountDeletion(deps, deletionId)).toBe('completed');
    expect(deps.cognito.deleted).toEqual([identity.username, identity.username]);
  });

  describe('marketplace grants', () => {
    function grant(marketplace: 'ebay' | 'depop' = 'ebay') {
      return {
        connectionId: randomUUID(),
        marketplace,
        tokenCiphertext: Buffer.from('ct'),
      } as const;
    }

    it('revokes confirmed grants at once and keeps asking for the others', async () => {
      const deps = harness();
      const [confirmed, unconfirmed, failing] = [grant(), grant('depop'), grant()];
      deps.marketplaceAccess.answer(unconfirmed.connectionId, false);
      deps.marketplaceAccess.answer(failing.connectionId, new Error('eBay is down'));
      const deletionId = await start({ provider: 'dev', subject: `${randomUUID()}@example.com` }, [
        confirmed,
        unconfirmed,
        failing,
      ]);

      expect(await completeAccountDeletion(deps, deletionId)).toBe('retrying');
      const byId = new Map(
        (await grants(deletionId)).map((row) => [row.connection_id, row] as const),
      );
      expect(byId.get(confirmed.connectionId)).toMatchObject({
        outcome: 'revoked',
        token_ciphertext: null,
      });
      for (const pending of [unconfirmed, failing]) {
        expect(byId.get(pending.connectionId)?.outcome).toBe('pending');
        expect(byId.get(pending.connectionId)?.token_ciphertext?.toString()).toBe('ct');
      }
      // A dev identity has nothing to delete at a provider.
      expect(await tombstone(deletionId)).toMatchObject({
        identity_deleted_at: expect.any(Date) as Date,
      });

      deps.marketplaceAccess.answer(unconfirmed.connectionId, true);
      deps.marketplaceAccess.answer(failing.connectionId, true);
      expect(await completeAccountDeletion(deps, deletionId)).toBe('completed');
      expect(deps.marketplaceAccess.revoked.map((asked) => asked.connectionId).sort()).toEqual(
        [confirmed, unconfirmed, failing, unconfirmed, failing].map((g) => g.connectionId).sort(),
      );
      expect(await grants(deletionId)).toEqual([]);
      expect(deps.logs).toContainEqual(
        expect.objectContaining({
          msg: 'account deletion completed',
          revoked: expect.arrayContaining(['ebay', 'depop', 'ebay']) as string[],
          revokeManually: [],
        }),
      );
    });

    it('gives up when the window ends: tokens deleted, the seller told to revoke', async () => {
      const policy = { delaysMs: [86_400_000], revocationWindowMs: 3_600_000 };
      const deps = harness({ policy });
      const unconfirmed = grant('depop');
      deps.marketplaceAccess.answer(unconfirmed.connectionId, false);
      const deletionId = await start({ provider: 'dev', subject: `${randomUUID()}@example.com` }, [
        unconfirmed,
      ]);

      expect(await completeAccountDeletion(deps, deletionId)).toBe('retrying');
      // The next run is the last try, at the end of the window, not a day later.
      const requestedAt = (await tombstone(deletionId))?.requested_at.getTime() ?? 0;
      expect((await jobOf(deletionId))?.runAt.getTime()).toBe(requestedAt + 3_600_000);

      const late = harness({ policy, now: () => requestedAt + 3_600_000 });
      late.marketplaceAccess.answer(unconfirmed.connectionId, false);
      expect(await completeAccountDeletion(late, deletionId)).toBe('completed');
      expect(await tombstone(deletionId)).toBeUndefined();
      expect(await grants(deletionId)).toEqual([]);
      expect(late.logs).toContainEqual(
        expect.objectContaining({
          level: 40,
          marketplace: 'depop',
          connectionId: unconfirmed.connectionId,
          msg: 'gave up revoking marketplace access of a deleted account; the seller must revoke it',
        }),
      );
      expect(late.logs).toContainEqual(
        expect.objectContaining({ msg: 'account deletion completed', revokeManually: ['depop'] }),
      );
    });

    it('asks again after a database failure that lost a confirmed revocation', async () => {
      const deps = harness();
      const confirmed = grant();
      const deletionId = await start({ provider: 'dev', subject: `${randomUUID()}@example.com` }, [
        confirmed,
      ]);
      await failUpdatesOf('account_deletion_grant');
      try {
        await expect(completeAccountDeletion(deps, deletionId)).rejects.toThrow(/simulated/);
        expect((await grants(deletionId))[0]?.outcome).toBe('pending');
      } finally {
        await restoreUpdatesOf('account_deletion_grant');
      }
      expect(await completeAccountDeletion(deps, deletionId)).toBe('completed');
      expect(deps.marketplaceAccess.revoked.map((asked) => asked.connectionId)).toEqual([
        confirmed.connectionId,
        confirmed.connectionId,
      ]);
    });
  });

  it('runs as a Graphile task, and drops a job with an invalid payload', async () => {
    const deps = harness();
    const identity = cognitoIdentity();
    const deletionId = await start(identity);
    const task = accountDeletionTask(deps);
    await task({ deletionId });
    expect(await tombstone(deletionId)).toBeUndefined();

    await task({ accountId: 'x' });
    expect(deps.logs).toContainEqual(
      expect.objectContaining({ msg: 'account deletion job with an invalid payload; dropping it' }),
    );
  });

  async function failUpdatesOf(table: 'account_deletion' | 'account_deletion_grant') {
    await sql`
      create function test_fail_update() returns trigger language plpgsql as $$
      begin
        raise exception 'simulated database failure';
      end;
      $$;
      create trigger test_fail_update before update on ${sql.table(table)}
        for each row execute function test_fail_update();
    `.execute(database.db);
  }

  async function restoreUpdatesOf(table: 'account_deletion' | 'account_deletion_grant') {
    await sql`
      drop trigger test_fail_update on ${sql.table(table)};
      drop function test_fail_update();
    `.execute(database.db);
  }
});
