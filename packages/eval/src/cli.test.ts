import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { EvalReport } from './harness.ts';

const entry = fileURLToPath(new URL('cli.ts', import.meta.url));

/** Upper bound for one CLI process; a cold start under a parallel test run takes seconds. */
const CLI_TIMEOUT_MS = 60_000;

/** Runs the CLI the way `npm run eval` does, as a real process. */
function runCli(...args: string[]) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] },
    timeout: CLI_TIMEOUT_MS,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// Each test spawns up to two CLI processes, so the vitest timeout covers two full CLI budgets
// rather than the 5s default, which a loaded machine exceeds.
describe('eval CLI', { timeout: 2 * CLI_TIMEOUT_MS }, () => {
  it('prints parser and fake-provider accuracy and the metered cost per item by default', () => {
    const { status, stdout, stderr } = runCli();
    expect(stderr).toBe('');
    expect(status).toBe(0);
    expect(stdout).toMatch(/^Tag eval: \d+ items from listora-synthetic-tags/);
    expect(stdout).toContain('provider:fake: fake AI provider');
    expect(stdout).toContain('metered at claude-haiku-5-5 prices');
    expect(stdout).toMatch(/^origin\s+\d+\.\d% \(\d+\/\d+\)/m);
    // The parsers cost nothing; the fake provider is metered at Haiku 5.5 prices.
    expect(stdout).toMatch(/^cost\/item\s+\$0\.000000\s+\$0\.0000[1-9]\d$/m);
  });

  it('meters the premium tier at its model prices', () => {
    const { status, stdout } = runCli('--tier', 'premium', '--json');
    expect(status).toBe(0);
    const report = JSON.parse(stdout) as EvalReport;
    const standard = JSON.parse(runCli('--json').stdout) as EvalReport;
    expect(report.systems[1]?.description).toContain('claude-sonnet-5-5');
    expect(report.systems[1]?.costMicrosTotal).toBeGreaterThan(
      (standard.systems[1]?.costMicrosTotal ?? 0) * 10,
    );
  });

  it('still offers the stub provider, which costs nothing', () => {
    const { status, stdout } = runCli('--provider', 'stub');
    expect(status).toBe(0);
    expect(stdout).toContain('provider:stub: stub provider');
    expect(stdout).toMatch(/^cost\/item\s+\$0\.000000\s+\$0\.000000$/m);
  });

  it('refuses the Anthropic provider without an API key, naming the key', () => {
    const { status, stderr, stdout } = runCli('--provider', 'anthropic');
    expect(status).toBe(1);
    expect(stderr).toContain('ANTHROPIC_API_KEY is required when AI_PROVIDER is anthropic');
    expect(stdout).toBe('');
  });

  it('honours the AI kill switch: every provider call fails and the run exits 1', () => {
    const result = spawnSync(process.execPath, [entry, '--json'], {
      encoding: 'utf8',
      env: { PATH: process.env['PATH'], AI_KILL_SWITCH: 'on' },
      timeout: CLI_TIMEOUT_MS,
    });
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout) as EvalReport;
    expect(report.systems[1]?.errors).toHaveLength(report.corpus.items);
    expect(report.systems[1]?.costMicrosTotal).toBe(0);
    expect(result.stderr).toMatch(/provider:fake: \d+ provider calls failed/);
  });

  it('passes the acceptance gate and fails a gate the corpus cannot meet', () => {
    expect(runCli('--provider', 'none', '--min-accuracy', '0.95').status).toBe(0);
    const strict = runCli('--provider', 'none', '--min-accuracy', '1');
    expect(strict.status).toBe(1);
    expect(strict.stderr).toMatch(
      /parsers: lowest field accuracy .* is below --min-accuracy 100\.0%/,
    );
  });

  it('prints a JSON report with --json', () => {
    const { status, stdout } = runCli('--provider', 'none', '--json');
    expect(status).toBe(0);
    const report = JSON.parse(stdout) as EvalReport;
    expect(report.systems.map((system) => system.id)).toEqual(['parsers']);
    expect(report.systems[0]?.fields.rn.items).toBe(report.corpus.items);
  });

  it.each([
    [['--provider', 'gemini'], /unknown provider "gemini"/],
    [['--tier', 'expert'], /unknown tier "expert"/],
    [['--min-accuracy', 'high'], /--min-accuracy must be a number from 0 to 1/],
    [['--min-accuracy', '1.5'], /--min-accuracy must be a number from 0 to 1/],
    [['--bogus'], /Unknown option '--bogus'/],
  ])('rejects bad usage %j with exit code 2', (args, message) => {
    const { status, stderr, stdout } = runCli(...args);
    expect(status).toBe(2);
    expect(stderr).toMatch(message);
    expect(stderr).toContain('Usage: npm run eval');
    expect(stdout).toBe('');
  });

  it('fails clearly when the corpus directory is not a corpus', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'listora-no-corpus-'));
    try {
      const { status, stderr } = runCli('--corpus', empty);
      expect(status).toBe(1);
      expect(stderr).toMatch(/^eval: ENOENT.*manifest\.json/);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
