import { Writable } from 'node:stream';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AiConfigError, AiControlError, topAccountsBySpend } from '@listora/ai';
import { createInventoryItem, jsonb, type Db } from '@listora/db';
import { createLogger } from '@listora/shared';

import { parseCommand } from './args.ts';
import { CommandError, runCommand } from './commands.ts';
import { insertAccount, insertEvent, migratedDatabase, type TestDatabase } from './test-support.ts';

const NOW = new Date('2026-10-24T12:00:00Z');
const MISSING_ACCOUNT = '00000000-0000-7000-8000-00000000dead';

let database: TestDatabase;
let db: Db;
let alpha: string;
let bravo: string;

beforeAll(async () => {
  database = await migratedDatabase('admin_commands');
  db = database.db;
  alpha = await insertAccount(db, 'Alpha Resale');
  bravo = await insertAccount(db, 'Bravo Vintage');
  const item = await createInventoryItem(db, alpha);
  await insertEvent(db, {
    accountId: alpha,
    costMicros: 1_430,
    at: '2026-10-03T10:00:00Z',
    itemId: item.id,
  });
  await insertEvent(db, {
    accountId: alpha,
    costMicros: 1_430,
    at: '2026-10-03T10:05:00Z',
    itemId: item.id,
    failed: true,
  });
  await insertEvent(db, { accountId: bravo, costMicros: 28_600, at: '2026-10-04T09:00:00Z' });
  // Over the default $1 daily budget on 2026-10-05.
  await insertEvent(db, { accountId: bravo, costMicros: 1_000_000, at: '2026-10-05T09:00:00Z' });
});

afterAll(async () => {
  await database.close();
});

let output: string;
let logLines: () => Record<string, unknown>[];
let logger: ReturnType<typeof createLogger>;

beforeEach(() => {
  output = '';
  const chunks: string[] = [];
  logger = createLogger({
    service: 'admin',
    level: 'info',
    destination: new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    }),
  });
  logLines = () =>
    chunks
      .join('')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
});

/** Parses and runs a command line the way the CLI does, capturing what it prints. */
async function run(argv: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  await runCommand(parseCommand(argv, NOW), {
    db,
    write: (text) => {
      output += text;
    },
    logger,
    env,
  });
  return output;
}

const change = ['--actor', 'ops-alice', '--reason', 'cost spike'];

describe('ai-cost reports (real Postgres)', () => {
  it('lists the top accounts by spend for a month', async () => {
    expect(await run(['ai-cost', 'accounts', '--month', '2026-10'])).toBe(
      [
        'AI spend for 2026-10 (UTC month): $1.031460, 4 calls (1 failed), 2 accounts',
        '',
        '#  Account                               Name                Cost  Calls  Failed  Share',
        `1  ${bravo}  Bravo Vintage  $1.028600      2       0  99.7%`,
        `2  ${alpha}  Alpha Resale   $0.002860      2       1   0.3%`,
        '',
      ].join('\n'),
    );
  });

  it('prints the same report as JSON', async () => {
    const report = JSON.parse(
      await run(['ai-cost', 'accounts', '--month', '2026-10', '--limit', '1', '--json']),
    ) as unknown;
    expect(report).toEqual(await topAccountsBySpend(db, { kind: 'month', month: '2026-10' }, 1));
  });

  it('says so when a period has no usage', async () => {
    expect(await run(['ai-cost', 'accounts'])).toBe(
      'AI spend for 2026-10-24 (UTC day): $0.000000, 0 calls (0 failed), 0 accounts\n' +
        'No AI usage in this period.\n',
    );
  });

  it("shows one account's usage for a month", async () => {
    expect(await run(['ai-cost', 'account', alpha, '--month', '2026-10'])).toBe(
      [
        `AI usage of account ${alpha} (Alpha Resale) for 2026-10 (UTC month)`,
        '',
        'cost                $0.002860',
        'calls               2 (1 failed)',
        'input tokens        13,600',
        'output tokens       3,000',
        'cache read tokens   0',
        'cache write tokens  0',
        'images              8',
        'web searches        0',
        '',
      ].join('\n'),
    );
  });

  it('fails for an account that does not exist', async () => {
    await expect(run(['ai-cost', 'account', MISSING_ACCOUNT])).rejects.toThrow(
      new CommandError(`no account ${MISSING_ACCOUNT}`),
    );
  });

  it('reports the AI cost per item', async () => {
    expect(await run(['ai-cost', 'items', '--month', '2026-10'])).toBe(
      [
        'AI cost per item for 2026-10 (UTC month), all accounts',
        '',
        'items worked on        1',
        'cost of those items    $0.002860',
        'average per item       $0.002860',
        'highest item           $0.002860',
        'calls without an item  2 ($1.028600)',
        '',
      ].join('\n'),
    );
  });

  it('breaks spend down by purpose and model', async () => {
    const text = await run(['ai-cost', 'breakdown', '--month', '2026-10', '--account', alpha]);
    expect(text).toContain(
      `AI spend by purpose and model for 2026-10 (UTC month), account ${alpha}: $0.002860`,
    );
    expect(text).toMatch(
      /^item_analysis\s+standard\s+claude-haiku-5-5\s+2\s+1\s+\$0\.002860\s+100\.0%\s+13,600\s+3,000$/m,
    );
  });
});

describe('ai-alerts check (real Postgres)', () => {
  it('prints the alerts and logs them as structured events', async () => {
    const text = await run(['ai-alerts', 'check', '--day', '2026-10-05']);
    expect(text).toBe(
      [
        'AI spend check for 2026-10-05 (UTC): $1.000000 spent of the $25.000000 global alert ' +
          'threshold; per-account daily budget $1.000000, warning from 80%',
        'kill switch off, 0 blocked accounts',
        '',
        'Severity  Alert                 Account                               Detail',
        `OVER      account_daily_budget  ${bravo}  $1.000000 of $1.000000 today`,
        '',
      ].join('\n'),
    );
    expect(logLines()).toEqual([
      expect.objectContaining({
        event: 'ai_spend_alert',
        alert: 'account_daily_budget',
        severity: 'over',
        accountId: bravo,
      }),
      expect.objectContaining({ event: 'ai_spend_check', accountsOverDailyBudget: 1 }),
    ]);
  });

  it('uses the thresholds from the environment', async () => {
    const check = JSON.parse(
      await run(['ai-alerts', 'check', '--day', '2026-10-05', '--json'], {
        AI_GLOBAL_DAILY_ALERT_USD: '1.00',
        AI_DAILY_BUDGET_USD: '5.00',
      }),
    ) as { alerts: { kind: string; severity: string }[] };
    expect(check.alerts).toEqual([
      expect.objectContaining({ kind: 'global_daily_spend', severity: 'over' }),
    ]);
  });

  it('refuses bad thresholds, naming the key', async () => {
    await expect(
      run(['ai-alerts', 'check'], { AI_ALERT_WARN_PERCENT: '500' }),
    ).rejects.toBeInstanceOf(AiConfigError);
  });
});

describe('AI controls (real Postgres)', () => {
  it('turns the kill switch on and off with an audit trail', async () => {
    expect(await run(['ai-kill-switch', 'on', ...change])).toBe('AI kill switch is now on.\n');
    output = '';
    expect(await run(['ai-kill-switch', 'on', ...change])).toBe(
      'AI kill switch was already on; nothing changed.\n',
    );
    output = '';
    expect(await run(['ai-kill-switch', 'status'])).toMatch(
      /^AI kill switch: ON - every AI call is refused \(set by ops-alice at \S+: cost spike\)\n0 accounts blocked/,
    );
    output = '';
    await run(['ai-kill-switch', 'off', '--actor', 'ops-bob', '--reason', 'all clear']);
    output = '';
    const audit = await run(['ai-audit', '--limit', '2']);
    expect(audit).toMatch(/^Time\s+Action\s+Account\s+Actor\s+Reason$/m);
    expect(audit).toMatch(/^\S+Z\s+kill_switch_off\s+-\s+ops-bob\s+all clear$/m);
    expect(audit).toMatch(/^\S+Z\s+kill_switch_on\s+-\s+ops-alice\s+cost spike$/m);
    expect(audit.indexOf('kill_switch_off')).toBeLessThan(audit.indexOf('kill_switch_on'));

    expect(logLines()).toEqual([
      expect.objectContaining({
        event: 'ai_control_changed',
        action: 'kill_switch_on',
        changed: true,
        actor: 'ops-alice',
      }),
      expect.objectContaining({
        event: 'ai_control_changed',
        action: 'kill_switch_on',
        changed: false,
      }),
      expect.objectContaining({
        event: 'ai_control_changed',
        action: 'kill_switch_off',
        changed: true,
        actor: 'ops-bob',
      }),
    ]);
  });

  it('blocks and unblocks an account', async () => {
    expect(await run(['ai-block', 'on', alpha, ...change])).toBe(
      `Account ${alpha} is now blocked from AI.\n`,
    );
    output = '';
    expect(await run(['ai-block', 'list'])).toMatch(
      new RegExp(`^${alpha}\\s+Alpha Resale\\s+\\S+Z\\s+ops-alice\\s+cost spike$`, 'm'),
    );
    output = '';
    expect(await run(['ai-block', 'off', alpha, ...change])).toBe(
      `Account ${alpha} is no longer blocked from AI.\n`,
    );
    output = '';
    expect(await run(['ai-block', 'off', alpha, ...change])).toBe(
      `Account ${alpha} was not blocked from AI; nothing changed.\n`,
    );
    output = '';
    expect(await run(['ai-block', 'list'])).toBe('No account is blocked from AI.\n');
    output = '';
    const audit = JSON.parse(await run(['ai-audit', '--account', alpha, '--json'])) as {
      action: string;
      accountId: string;
    }[];
    expect(audit.map((entry) => entry.action)).toEqual(['account_block_off', 'account_block_on']);
    expect(logLines()).toContainEqual(
      expect.objectContaining({
        event: 'ai_control_changed',
        action: 'account_block_on',
        accountId: alpha,
      }),
    );
  });

  it('refuses to block an account that does not exist', async () => {
    await expect(run(['ai-block', 'on', MISSING_ACCOUNT, ...change])).rejects.toThrow(
      new AiControlError(`no account ${MISSING_ACCOUNT}`),
    );
    expect(logLines()).toEqual([]);
  });
});

describe('marketplace-purge (real Postgres)', () => {
  const operator = ['--actor', 'ops-alice', '--reason', 'Depop ended partner access'];

  async function connection(accountId: string, mode: 'api' | 'automation'): Promise<string> {
    const row = await db
      .insertInto('marketplace_connection')
      .values({
        account_id: accountId,
        marketplace: 'depop',
        mode,
        external_user_id: mode === 'api' ? `depop-${accountId}` : null,
        token_ciphertext: Buffer.from('sealed'),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  it('counts first, then deletes every connection in that mode and leaves the rest', async () => {
    const charlie = await insertAccount(db, 'Charlie Closet');
    const apiOne = await connection(alpha, 'api');
    const apiTwo = await connection(charlie, 'api');
    const automation = await connection(bravo, 'automation');
    const remaining = async () =>
      (
        await db
          .selectFrom('marketplace_connection')
          .select('id')
          .where('id', 'in', [apiOne, apiTwo, automation])
          .execute()
      ).map((row) => row.id);

    expect(await run(['marketplace-purge', 'depop', '--mode', 'api', ...operator])).toBe(
      '2 Depop api connections would be deleted. Run again with --confirm to delete them.\n',
    );
    expect((await remaining()).sort()).toEqual([apiOne, apiTwo, automation].sort());

    output = '';
    expect(
      await run(['marketplace-purge', 'depop', '--mode', 'api', ...operator, '--confirm']),
    ).toBe(
      'Deleted the data of 2 Depop api connections. The worker revokes their grants and records each deletion.\n',
    );
    expect(await remaining()).toEqual([automation]);
    const tombstones = await db
      .selectFrom('connection_deletion')
      .select(['connection_id', 'reason', 'revocation'])
      .where('connection_id', 'in', [apiOne, apiTwo])
      .execute();
    expect(tombstones).toHaveLength(2);
    expect(tombstones.every((row) => row.reason === 'marketplace_terminated')).toBe(true);
    expect(tombstones.every((row) => row.revocation === 'pending')).toBe(true);
    expect(logLines()).toContainEqual(
      expect.objectContaining({
        event: 'marketplace_purge',
        marketplace: 'depop',
        mode: 'api',
        connections: 2,
        actor: 'ops-alice',
      }),
    );
  });
});

describe('activity and sale detection (real Postgres)', () => {
  /** A Mercari automation connection of Alpha's that runs on the phone, with its schedule. */
  async function mercari(): Promise<string> {
    const existing = await db
      .selectFrom('marketplace_connection')
      .select('id')
      .where('account_id', '=', alpha)
      .where('marketplace', '=', 'mercari')
      .executeTakeFirst();
    if (existing !== undefined) return existing.id;
    const connection = await db
      .insertInto('marketplace_connection')
      .values({
        account_id: alpha,
        marketplace: 'mercari',
        mode: 'automation',
        status: 'connected',
        token_ciphertext: Buffer.from('sealed'),
        runs_on: 'phone',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('sale_check_schedule')
      .values({
        account_id: alpha,
        connection_id: connection.id,
        marketplace: 'mercari',
        next_check_at: new Date('2026-10-24T13:00:00Z'),
        next_reason: 'retry',
        failures_in_a_row: 2,
        last_error_code: 'element_missing',
        last_error_message: "Mercari's sold items page has changed, so Listora couldn't read it.",
        health: 'failing',
        unhealthy_since: new Date('2026-10-24T10:00:00Z'),
      })
      .execute();
    return connection.id;
  }

  it('asks for a read-only sold history read on the phone, then shows what it saw', async () => {
    const connectionId = await mercari();
    const asked = await run(['sale-history', 'read', 'mercari', '--account', alpha]);
    expect(asked).toContain(
      `read-only read of the Mercari sold history (connection ${connectionId})`,
    );
    expect(asked).toContain('runs on the seller’s iPhone');
    const waiting = await db
      .selectFrom('phone_work')
      .select('purpose')
      .where('connection_id', '=', connectionId)
      .execute();
    expect(waiting).toEqual([{ purpose: 'sale_history' }]);
    expect(logLines()).toEqual([
      expect.objectContaining({ event: 'sale_history_requested', connectionId, queued: true }),
    ]);

    await db
      .insertInto('sale_check_run')
      .values({
        account_id: alpha,
        connection_id: connectionId,
        marketplace: 'mercari',
        kind: 'history',
        host: 'phone',
        started_at: new Date('2026-10-24T11:00:00Z'),
        finished_at: new Date('2026-10-24T11:00:09Z'),
        outcome: 'succeeded',
        orders_seen: 1,
        items_seen: 1,
        new_orders: 0,
        newest_sold_at: new Date('2026-09-30T16:00:00Z'),
        oldest_sold_at: new Date('2026-09-30T16:00:00Z'),
        orders: jsonb([
          {
            orderId: 'm-123',
            soldAt: '2026-09-30T16:00:00.000Z',
            items: [{ listingId: 'm555', title: 'Coach bag', priceCents: 6500 }],
          },
        ]),
      })
      .execute();
    output = '';
    const shown = await run(['sale-history', 'show', 'mercari', '--account', alpha]);
    expect(shown).toContain('sold orders seen  1');
    expect(shown).toContain('2026-09-30T16:00:00.000Z  m-123  m555     $65.00  Coach bag');
  });

  it('lists sale-check health and the latest checks, and searches a timeline', async () => {
    await mercari();
    const health = await run(['sale-checks', '--account', alpha]);
    expect(health).toContain('failing');
    expect(health).toContain("Mercari's sold items page has changed, so Listora couldn't read it.");
    output = '';
    const timeline = await run(['activity', '--account', alpha, '--marketplace', 'mercari']);
    expect(timeline).toContain('Read your Mercari sold history');
    expect(timeline).toContain('Saw 1 sold order on your iPhone. Nothing was changed.');
  });

  it("lists every connection's reads and when each last worked, with the last error", async () => {
    const connectionId = await mercari();
    await db
      .insertInto('background_read_health')
      .values([
        {
          account_id: alpha,
          connection_id: connectionId,
          marketplace: 'mercari',
          read: 'sale_check',
          last_succeeded_at: new Date('2026-10-26T06:00:00Z'),
          last_failed_at: new Date('2026-10-27T18:00:00Z'),
          failures_in_a_row: 7,
          failing_since: new Date('2026-10-26T10:00:00Z'),
          last_error_code: 'element_missing',
          last_error_step: 'read the in progress sales',
          last_error_detail: "Mercari's in progress tab has rows that link to no listing.",
          owner_alerted_at: new Date('2026-10-26T20:00:00Z'),
        },
        {
          account_id: alpha,
          connection_id: connectionId,
          marketplace: 'mercari',
          read: 'offer_check',
          last_succeeded_at: new Date('2026-10-27T19:00:00Z'),
        },
      ])
      .onConflict((conflict) =>
        conflict.columns(['account_id', 'connection_id', 'read']).doNothing(),
      )
      .execute();
    const table = await run(['read-health', '--account', alpha]);
    const line = (read: string) => table.split('\n').find((row) => row.includes(read)) ?? '';
    expect(line('sale check')).toContain('2026-10-26T06:00:00.000Z');
    expect(line('sale check')).toContain('2026-10-26T20:00:00.000Z');
    expect(line('sale check')).toContain(
      `element_missing at "read the in progress sales": Mercari's in progress tab has rows that link to no listing.`,
    );
    expect(line('offer check')).toContain('2026-10-27T19:00:00.000Z');
    expect(line('listing import')).toContain('never ran');
    output = '';
    const json = JSON.parse(await run(['read-health', '--account', alpha, '--json'])) as {
      read: string;
      failuresInARow: number;
      lastSucceededAt: string | null;
    }[];
    expect(json.map(({ read, failuresInARow }) => [read, failuresInARow])).toEqual([
      ['sale_check', 7],
      ['listing_import', 0],
      ['offer_check', 0],
    ]);
  });

  it('lists the Test mode runs, newest first, with their outcome and error', async () => {
    const subject = '0199f0b4-0000-7000-8000-00000000c0de';
    await db
      .insertInto('feature_test_run')
      .values([
        {
          account_id: alpha,
          marketplace: 'poshmark',
          feature: 'offers',
          outcome: 'failed',
          subject_id: subject,
          error_code: 'element_missing',
          detail: 'read the offers: no offer rows',
          created_at: new Date('2026-10-28T10:00:00Z'),
        },
        {
          account_id: alpha,
          marketplace: 'depop',
          feature: 'revise',
          outcome: 'passed',
          subject_id: subject,
          created_at: new Date('2026-10-28T11:00:00Z'),
        },
      ])
      .execute();
    output = '';
    const table = await run(['feature-tests', '--account', alpha]);
    const lines = table.split('\n').filter((line) => line.includes('2026-10-28'));
    expect(lines[0]).toContain('revise');
    expect(lines[0]).toContain('passed');
    expect(lines[1]).toContain('element_missing: read the offers: no offer rows');
    output = '';
    const json = JSON.parse(
      await run(['feature-tests', '--account', alpha, '--marketplace', 'depop', '--json']),
    ) as { feature: string; outcome: string }[];
    expect(json.map(({ feature, outcome }) => [feature, outcome])).toEqual([['revise', 'passed']]);
  });

  it('says plainly when a sale or a connection is missing', async () => {
    await expect(run(['sale-why', MISSING_ACCOUNT])).rejects.toThrow(CommandError);
    await expect(run(['sale-history', 'read', 'depop', '--account', alpha])).rejects.toThrow(
      'has no working Depop automation connection',
    );
  });
});
