/**
 * Who has Test mode besides the deployment owner's account (docs/features/test-mode.md, "Who
 * has it"): the owner grants it to an account here, without a redeploy, and revokes it, which
 * also turns the account's switch off. Each change lands in the account's audit log and the
 * operator log. `account-find` finds the account to grant by its marketplace shop.
 */
import { jsonb } from '@listora/db';
import { MARKETPLACE_NAMES } from '@listora/marketplaces';
import { sql } from 'kysely';

import type { Command } from './args.ts';
import { CommandError, type CommandContext } from './commands.ts';
import { formatTable } from './format.ts';

type TestModeAccessCommand = Extract<
  Command,
  { name: 'test-mode-access-list' | 'test-mode-access-set' | 'account-find' }
>;

export async function runTestModeAccessCommand(
  command: TestModeAccessCommand,
  context: CommandContext,
): Promise<void> {
  switch (command.name) {
    case 'test-mode-access-list':
      await listGrants(command, context);
      return;
    case 'test-mode-access-set':
      await setAccess(command, context);
      return;
    case 'account-find':
      await findAccounts(command, context);
      return;
  }
}

async function listGrants(
  command: Extract<Command, { name: 'test-mode-access-list' }>,
  { db, write }: CommandContext,
): Promise<void> {
  const accounts = await db
    .selectFrom('account')
    .select(['id', 'name', 'test_mode', 'test_mode_granted_at'])
    .where('test_mode_granted_at', 'is not', null)
    .orderBy('test_mode_granted_at')
    .orderBy('id')
    .execute();
  if (command.json) {
    write(
      `${JSON.stringify(
        accounts.map((account) => ({
          accountId: account.id,
          name: account.name,
          grantedAt: account.test_mode_granted_at,
          on: account.test_mode,
        })),
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (accounts.length === 0) {
    write('No account is granted Test mode.\n');
    return;
  }
  write(
    `${formatTable(
      ['Account', 'Name', 'Granted', 'Switch'],
      accounts.map((account) => [
        account.id,
        account.name,
        account.test_mode_granted_at?.toISOString() ?? '-',
        account.test_mode ? 'on' : 'off',
      ]),
    )}\n`,
  );
}

async function setAccess(
  command: Extract<Command, { name: 'test-mode-access-set' }>,
  { db, write, logger }: CommandContext,
): Promise<void> {
  const { accountId, granted, change } = command;
  const changed = await db.transaction().execute(async (trx) => {
    const account = await trx
      .selectFrom('account')
      .select(['test_mode', 'test_mode_granted_at'])
      .where('id', '=', accountId)
      .forUpdate()
      .executeTakeFirst();
    if (account === undefined) throw new CommandError(`No account ${accountId}.`);
    const had = account.test_mode_granted_at !== null;
    if (granted ? had : !had && !account.test_mode) return false;
    await trx
      .updateTable('account')
      .set(
        granted
          ? { test_mode_granted_at: sql<Date>`now()` }
          : { test_mode_granted_at: null, test_mode: false },
      )
      .where('id', '=', accountId)
      .execute();
    await trx
      .insertInto('audit_log')
      .values({
        account_id: accountId,
        actor_kind: 'system',
        action: granted ? 'account.test_mode_granted' : 'account.test_mode_revoked',
        changes: jsonb({ actor: change.actor.trim(), reason: change.reason.trim() }),
      })
      .execute();
    return true;
  });
  logger.warn(
    {
      event: granted ? 'test_mode_granted' : 'test_mode_revoked',
      accountId,
      changed,
      actor: change.actor.trim(),
      reason: change.reason.trim(),
    },
    changed ? 'Test mode access changed' : 'Test mode access already in the requested state',
  );
  const account = `Account ${accountId}`;
  if (granted) {
    write(
      changed
        ? `${account} now has Test mode: its owner and admins see the switch in Settings.\n`
        : `${account} already had Test mode; nothing changed.\n`,
    );
  } else {
    write(
      changed
        ? `${account} no longer has Test mode, and its switch is off.\n`
        : `${account} had no Test mode grant; nothing changed.\n`,
    );
  }
}

async function findAccounts(
  command: Extract<Command, { name: 'account-find' }>,
  { db, write }: CommandContext,
): Promise<void> {
  const shop = command.shop.toLowerCase();
  const rows = await db
    .selectFrom('marketplace_connection')
    .innerJoin('account', 'account.id', 'marketplace_connection.account_id')
    .select([
      'account.id as account_id',
      'account.name',
      'account.test_mode',
      'account.test_mode_granted_at',
      'marketplace_connection.marketplace',
      'marketplace_connection.mode',
      'marketplace_connection.external_user_id',
      'marketplace_connection.display_name',
    ])
    .where((eb) =>
      eb.or([
        eb(sql<string>`lower(marketplace_connection.external_user_id)`, '=', shop),
        eb(sql<string>`lower(marketplace_connection.display_name)`, '=', shop),
      ]),
    )
    .orderBy('account.id')
    .orderBy('marketplace_connection.marketplace')
    .execute();
  if (command.json) {
    write(
      `${JSON.stringify(
        rows.map((row) => ({
          accountId: row.account_id,
          name: row.name,
          marketplace: row.marketplace,
          mode: row.mode,
          shop: row.external_user_id ?? row.display_name,
          testModeGrantedAt: row.test_mode_granted_at,
          testModeOn: row.test_mode,
        })),
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (rows.length === 0) {
    write(`No account has a connection to the shop ${command.shop}.\n`);
    return;
  }
  write(
    `${formatTable(
      ['Account', 'Name', 'Marketplace', 'Mode', 'Shop', 'Test mode grant', 'Switch'],
      rows.map((row) => [
        row.account_id,
        row.name,
        MARKETPLACE_NAMES[row.marketplace],
        row.mode,
        row.external_user_id ?? row.display_name ?? '-',
        row.test_mode_granted_at?.toISOString() ?? '-',
        row.test_mode ? 'on' : 'off',
      ]),
    )}\n`,
  );
}
