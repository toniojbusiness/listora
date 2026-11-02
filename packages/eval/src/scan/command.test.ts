import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { scanCommand, ScanUsageError, SCAN_USAGE } from './command.ts';
import { writeScanDataset } from './test-support.ts';

async function run(argv: readonly string[]): Promise<{ status: number; output: string }> {
  let output = '';
  const status = await scanCommand(argv, { AI_PROVIDER: 'fake' }, (text) => {
    output += text;
  });
  return { status, output };
}

describe('npm run eval -- scan', () => {
  it('backtests a set on the fake provider by default', async () => {
    const { status, output } = await run(['--dataset', await writeScanDataset()]);
    expect(status).toBe(0);
    expect(output).toContain('AI read: fake');
    expect(output).toContain('The call at worth listing $8.00');
  });

  it('runs without AI, with a worth-listing amount, as JSON', async () => {
    const dir = await writeScanDataset();
    const { output } = await run([
      '--dataset',
      dir,
      '--provider',
      'none',
      '--worth-listing',
      '12.50',
      '--limit',
      '3',
      '--json',
    ]);
    const report = JSON.parse(output) as { read: unknown; settings: { worthListingCents: number } };
    expect(report.read).toBeNull();
    expect(report.settings.worthListingCents).toBe(1_250);
  });

  it('looks the reads up on the web, and replays an earlier report’s reads at no cost', async () => {
    const dir = await writeScanDataset();
    const first = await run(['--dataset', dir, '--research', '--json']);
    const report = JSON.parse(first.output) as {
      read: { costMicrosTotal: number };
      research: { overall: { lookedUp: number } };
    };
    expect(report.research.overall.lookedUp).toBe(7);
    expect(report.read.costMicrosTotal).toBeGreaterThan(0);

    const saved = join(await mkdtemp(join(tmpdir(), 'listora-scan-report-')), 'report.json');
    await writeFile(saved, first.output);
    const replayed = await run([
      '--dataset',
      dir,
      '--reads',
      saved,
      '--research',
      '--max-spend',
      '0.50',
      '--json',
    ]);
    const again = JSON.parse(replayed.output) as {
      reader: { id: string };
      read: { scanned: number; costMicrosTotal: number };
      research: { overall: { lookedUp: number } };
    };
    expect(again.reader.id).toBe('replay');
    expect(again.read).toMatchObject({ scanned: 8, costMicrosTotal: 0 });
    expect(again.research.overall.lookedUp).toBe(7);
  });

  it('stops spending at the cap: what comes after fails instead of being sent', async () => {
    const { status, output } = await run([
      '--dataset',
      await writeScanDataset(),
      '--research',
      '--max-spend',
      '0.01',
      '--json',
    ]);
    const report = JSON.parse(output) as {
      read: { failed: number };
      research: { overall: { lookedUp: number } };
    };
    // The first lookup ($0.01 a search) spends the cap; every read after it is refused.
    expect(status).toBe(1);
    expect(report.research.overall.lookedUp).toBe(1);
    expect(report.read.failed).toBe(7);
  });

  it('shows its usage', async () => {
    expect((await run(['--help'])).output).toBe(SCAN_USAGE);
  });

  it.each([
    [[], '--dataset is required'],
    [['--dataset', 'x', '--provider', 'openai'], 'unknown provider'],
    [['--dataset', 'x', '--images', '3'], '--images must be 1 or 2'],
    [['--dataset', 'x', '--worth-listing', '$8'], '--worth-listing must be dollars'],
    [['--dataset', 'x', '--limit', '0'], '--limit must be a whole number'],
    [['--dataset', 'x', '--max-spend', 'lots'], '--max-spend must be dollars'],
  ])('refuses %j', async (argv, message) => {
    const error = await run(argv).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(ScanUsageError);
    expect((error as Error).message).toContain(message);
  });
});
