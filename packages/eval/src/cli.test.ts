import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { EvalReport } from './harness.ts';

const entry = fileURLToPath(new URL('cli.ts', import.meta.url));

/** Runs the CLI the way `npm run eval` does, as a real process. */
function runCli(...args: string[]) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] },
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('eval CLI', () => {
  it('prints parser and stub-provider accuracy and cost per item by default', () => {
    const { status, stdout, stderr } = runCli();
    expect(stderr).toBe('');
    expect(status).toBe(0);
    expect(stdout).toMatch(/^Tag eval: \d+ items from listora-synthetic-tags/);
    expect(stdout).toContain('provider:stub: stub provider');
    expect(stdout).toMatch(/^origin\s+\d+\.\d% \(\d+\/\d+\)/m);
    expect(stdout).toMatch(/^cost\/item\s+\$0\.000000\s+\$0\.000000$/m);
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
    [['--provider', 'anthropic'], /unknown provider "anthropic"/],
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
