import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { insertAccount, insertEvent, migratedDatabase, type TestDatabase } from './test-support.ts';

const entry = fileURLToPath(new URL('cli.ts', import.meta.url));

interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the real CLI (`node src/cli.ts ...`), the way `npm run admin` does. */
function cli(env: NodeJS.ProcessEnv, ...args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [entry, ...args],
      { env: { PATH: process.env['PATH'], ...env }, timeout: 20_000 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

function jsonLines(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

let database: TestDatabase;
let env: NodeJS.ProcessEnv;
let accountId: string;

beforeAll(async () => {
  database = await migratedDatabase('admin_cli');
  env = { DATABASE_URL: database.url };
  accountId = await insertAccount(database.db, 'CLI Account');
  await insertEvent(database.db, { accountId, costMicros: 2_500, at: '2026-08-10T08:00:00Z' });
});

afterAll(async () => {
  await database.close();
});

describe('admin CLI (real process, real Postgres)', () => {
  it('turns the kill switch on, shows it, audits it, and turns it off', async () => {
    const on = await cli(env, 'ai-kill-switch', 'on', '--actor', 'ops', '--reason', 'drill');
    expect(on).toMatchObject({ code: 0, stdout: 'AI kill switch is now on.\n' });
    expect(jsonLines(on.stderr)).toEqual([
      expect.objectContaining({
        service: 'admin',
        event: 'ai_control_changed',
        action: 'kill_switch_on',
        changed: true,
        actor: 'ops',
      }),
    ]);

    const status = await cli(env, 'ai-kill-switch', 'status');
    expect(status.code).toBe(0);
    expect(status.stdout).toContain('AI kill switch: ON - every AI call is refused (set by ops');

    const audit = await cli(env, 'ai-audit', '--json');
    expect(audit.code).toBe(0);
    expect(JSON.parse(audit.stdout)).toEqual([
      expect.objectContaining({ action: 'kill_switch_on', actor: 'ops', reason: 'drill' }),
    ]);

    const off = await cli(env, 'ai-kill-switch', 'off', '--actor', 'ops', '--reason', 'drill over');
    expect(off).toMatchObject({ code: 0, stdout: 'AI kill switch is now off.\n' });
  });

  it('prints a cost report', async () => {
    const result = await cli(env, 'ai-cost', 'accounts', '--month', '2026-08');
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^1 {2}\S+ {2}CLI Account {2}\$0\.002500 {6}1 {7}0 {2}100\.0%$/m);
  });

  it('logs the spend check as JSON lines on stderr and prints the summary on stdout', async () => {
    const result = await cli(
      { ...env, AI_GLOBAL_DAILY_ALERT_USD: '0.002' },
      'ai-alerts',
      'check',
      '--day',
      '2026-08-10',
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('OVER      global_daily_spend');
    expect(jsonLines(result.stderr)).toEqual([
      expect.objectContaining({ level: 50, event: 'ai_spend_alert', alert: 'global_daily_spend' }),
      expect.objectContaining({ level: 30, event: 'ai_spend_check', globalDailySpend: 'over' }),
    ]);
  });

  it('exits 2 with the usage on a usage error, touching nothing', async () => {
    const result = await cli(env, 'ai-kill-switch', 'on', '--actor', 'ops');
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(
      /^admin: --reason is required: why this change is being made\n\nUsage:/,
    );
  });

  it('exits 1 with the reason when a change is refused', async () => {
    const missing = '00000000-0000-7000-8000-00000000dead';
    const result = await cli(env, 'ai-block', 'on', missing, '--actor', 'ops', '--reason', 'x');
    expect(result).toEqual({ code: 1, stdout: '', stderr: `admin: no account ${missing}\n` });
  });

  it('shows help without a database', async () => {
    const result = await cli({}, '--help');
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^Usage: npm run admin -- <command> \[options\]/);
  });

  it('exits 1 naming the missing key when DATABASE_URL is unset', async () => {
    const result = await cli({}, 'ai-kill-switch', 'status');
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('admin: Invalid admin configuration:\n- DATABASE_URL is required\n');
  });

  it('exits 1 when the database is unreachable, without printing the URL', async () => {
    const url = 'postgres://listora:hunter2@127.0.0.1:1/listora_test';
    const result = await cli({ DATABASE_URL: url }, 'ai-kill-switch', 'status');
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^admin: connect ECONNREFUSED 127\.0\.0\.1:1/);
    expect(result.stderr).not.toContain('hunter2');
  });
});
