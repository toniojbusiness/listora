import { Writable } from 'node:stream';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AiConfigError, AiControlError, topAccountsBySpend } from '@listora/ai';
import { createInventoryItem, type Db } from '@listora/db';
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
