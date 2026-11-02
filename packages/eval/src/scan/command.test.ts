import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { scanCommand, ScanUsageError, SCAN_USAGE } from './command.ts';
import { writeScanDataset } from './test-support.ts';

interface ReportShape {
  reader: { description: string } | null;
  researcher: { id: string } | null;
  items: { id: string; research?: unknown }[];
  prices: unknown[];
}

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

  it('looks each read up on the web, and answers again from the stored report for free', async () => {
    const dir = await writeScanDataset();
    const first = await run(['--dataset', dir, '--research', '--json']);
    const stored = join(await mkdtemp(join(tmpdir(), 'listora-scan-run-')), 'run.json');
    await writeFile(stored, first.output);
    const recorded = JSON.parse(first.output) as ReportShape;
    expect(recorded.researcher?.id).toBe('fake');
    expect(recorded.items.filter((entry) => entry.research !== undefined)).toHaveLength(7);

    const replayed = await run(['--dataset', dir, '--replay', stored, '--json']);
    const again = JSON.parse(replayed.output) as ReportShape;
    expect(again.reader?.description).toContain('stored answers from run.json');
    expect(again.items).toEqual(recorded.items);
    expect(again.prices).toEqual(recorded.prices);
    // A stored run with no web research replays its reads alone.
    const plain = await run(['--dataset', dir, '--json']);
    await writeFile(stored, plain.output);
    const readsOnly = JSON.parse(
      (await run(['--dataset', dir, '--replay', stored, '--json'])).output,
    ) as ReportShape;
    expect(readsOnly.researcher).toBeNull();
  });

  it('refuses a replay file that is not a report', async () => {
    const stored = join(await mkdtemp(join(tmpdir(), 'listora-scan-run-')), 'run.json');
    await writeFile(stored, JSON.stringify({ items: 'none' }));
    await expect(run(['--dataset', await writeScanDataset(), '--replay', stored])).rejects.toThrow(
      "is not a scan backtest's --json report",
    );
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
  ])('refuses %j', async (argv, message) => {
    const error = await run(argv).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(ScanUsageError);
    expect((error as Error).message).toContain(message);
  });
});
