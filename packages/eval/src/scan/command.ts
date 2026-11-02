// `npm run eval -- scan`: the thrift-scan backtest (docs/features/thrift-scan.md, "Backtest").
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import {
  createAiClient,
  FakeAiProvider,
  InMemoryUsageStore,
  loadAiConfig,
  type AiClient,
} from '@listora/ai';
import { DEFAULT_SCAN_CALL_SETTINGS } from '@listora/sourcing';

import { runScanBacktest } from './backtest.ts';
import { loadScanDataset, type ScanDataset } from './dataset.ts';
import { fakeScanFixtures } from './fake.ts';
import { AiScanReader, ReplayScanReader, type ScanReader } from './readers.ts';
import { AiScanResearcher, type ScanResearcher } from './research.ts';
import { formatScanReport } from './report.ts';

const PROVIDERS = ['fake', 'anthropic', 'none'] as const;
type ScanProvider = (typeof PROVIDERS)[number];

export const SCAN_USAGE = `Usage: npm run eval -- scan --dataset <dir> [options]

Backtests the Buy / Your call / Skip call on a set of sold items (a private set lives outside
the repository; see docs/features/thrift-scan.md for its format).

Options:
  --dataset <dir>        the set's directory, holding manifest.json and the photos (required)
  --provider <name>      ${PROVIDERS.join(' | ')} (default: fake); anthropic sends every photo to
                         the real API, needs ANTHROPIC_API_KEY, and spends real money
  --images <n>           photos per scan: 1 (the shot) or 2 (with a closer look) (default: 1)
  --worth-listing <usd>  the worth-listing amount in dollars (default: ${(DEFAULT_SCAN_CALL_SETTINGS.worthListingCents / 100).toFixed(2)})
  --limit <n>            only the first n items (caps the cost of a live run)
  --research             look each read with a brand up on the web, as the scan does (on
                         anthropic each lookup searches the web at about $0.01 a search)
  --reads <report.json>  replay the reads of an earlier --json report instead of reading again
                         (free; the provider then serves only the research)
  --max-spend <usd>      stop spending at this many dollars of AI (default: AI_DAILY_BUDGET_USD)
  --items                one line per item: its id, sale, payout, AI range, and calls (no titles)
  --json                 the full report as JSON (it includes the AI's reads)
  --help                 show this message
`;

export class ScanUsageError extends Error {}

/** Runs the backtest and prints its report; the exit status. */
export async function scanCommand(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  write: (text: string) => void,
): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      dataset: { type: 'string' },
      provider: { type: 'string', default: 'fake' },
      images: { type: 'string', default: '1' },
      'worth-listing': { type: 'string' },
      limit: { type: 'string' },
      research: { type: 'boolean', default: false },
      reads: { type: 'string' },
      'max-spend': { type: 'string' },
      items: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    write(SCAN_USAGE);
    return 0;
  }
  if (values.dataset === undefined) throw new ScanUsageError('--dataset is required');
  const provider = PROVIDERS.find((known) => known === values.provider);
  if (provider === undefined) throw new ScanUsageError(`unknown provider "${values.provider}"`);
  if (values.images !== '1' && values.images !== '2') {
    throw new ScanUsageError('--images must be 1 or 2');
  }
  const images = Number(values.images);
  const worthListingCents = parseDollars(values['worth-listing'], '--worth-listing');
  const limit = parseLimit(values.limit);
  const maxSpendCents = parseDollars(values['max-spend'], '--max-spend');
  const aiEnv: NodeJS.ProcessEnv =
    maxSpendCents === undefined
      ? env
      : { ...env, AI_DAILY_BUDGET_USD: (maxSpendCents / 100).toFixed(2) };

  const loaded = await loadScanDataset(values.dataset);
  const dataset: ScanDataset =
    limit === undefined
      ? loaded
      : {
          ...loaded,
          manifest: { ...loaded.manifest, items: loaded.manifest.items.slice(0, limit) },
        };
  const client = await createClient(provider, dataset, images, aiEnv);
  const reader: ScanReader | undefined =
    values.reads === undefined
      ? client === undefined
        ? undefined
        : new AiScanReader({
            id: provider,
            description: `${client.description}, ${String(images)} image${images === 1 ? '' : 's'} per scan`,
            client: client.client,
            images,
          })
      : new ReplayScanReader(
          JSON.parse(await readFile(values.reads, 'utf8')) as unknown,
          values.reads,
        );
  if (values.research && (client === undefined || reader === undefined)) {
    throw new ScanUsageError('--research needs a provider to search with (not none)');
  }
  const researcher: ScanResearcher | undefined =
    values.research && client !== undefined
      ? new AiScanResearcher({
          id: provider,
          description: client.description,
          client: client.client,
        })
      : undefined;
  const report = await runScanBacktest(dataset, {
    ...(reader === undefined ? {} : { reader }),
    ...(researcher === undefined ? {} : { researcher }),
    settings: {
      ...DEFAULT_SCAN_CALL_SETTINGS,
      ...(worthListingCents === undefined ? {} : { worthListingCents }),
    },
  });
  write(
    values.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : formatScanReport(report, { items: values.items }),
  );
  return report.read !== null && report.read.failed > 0 ? 1 : 0;
}

/** The provider's client: one for the reads and the research, so one budget holds both. */
async function createClient(
  provider: ScanProvider,
  dataset: ScanDataset,
  images: number,
  env: NodeJS.ProcessEnv,
): Promise<{ client: AiClient; description: string } | undefined> {
  if (provider === 'none') return undefined;
  let client: AiClient;
  let description: string;
  if (provider === 'fake') {
    const config = loadAiConfig({ ...env, AI_PROVIDER: 'fake' });
    client = createAiClient(config, {
      usageStore: new InMemoryUsageStore(),
      provider: new FakeAiProvider({ fixtures: await fakeScanFixtures(dataset, images) }),
    });
    description =
      `fake AI provider: answers from the set's labels and asking prices, metered at ` +
      `${config.models.standard} prices; no network`;
  } else {
    const config = loadAiConfig({ ...env, AI_PROVIDER: 'anthropic' });
    client = createAiClient(config, { usageStore: new InMemoryUsageStore() });
    description = `Anthropic API: ${config.models.standard} (standard tier)`;
  }
  return { client, description };
}

function parseDollars(raw: string | undefined, option: string): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(raw)) {
    throw new ScanUsageError(`${option} must be dollars, for example 12 or 12.50`);
  }
  return Math.round(Number(raw) * 100);
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^[1-9]\d{0,5}$/.test(raw))
    throw new ScanUsageError('--limit must be a whole number from 1');
  return Number(raw);
}
