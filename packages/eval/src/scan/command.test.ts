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
