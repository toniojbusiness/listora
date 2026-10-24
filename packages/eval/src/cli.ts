// Tag eval harness CLI. Scores the deterministic parsers, and an attribute provider, on the
// synthetic tag corpus and prints per-field accuracy and cost per item.
//   npm run eval                        parsers + fake AI provider (fixtures, no network)
//   npm run eval -- --provider none     parsers only
//   npm run eval -- --provider anthropic --tier premium   real API; needs ANTHROPIC_API_KEY
//   npm run eval -- --min-accuracy 0.95 --mismatches
import { parseArgs } from 'node:util';

import {
  AI_TIERS,
  createAiClient,
  FakeAiProvider,
  directoryFixtures,
  InMemoryUsageStore,
  loadAiConfig,
  type AiTier,
} from '@listora/ai';

import { AiEvalProvider } from './ai-provider.ts';
import { DEFAULT_CORPUS_DIR, loadCorpus } from './corpus/store.ts';
import { DEFAULT_FAKE_FIXTURES_DIR } from './fake-fixtures.ts';
import { runEval } from './harness.ts';
import { StubProvider, type EvalProvider } from './provider.ts';
import { formatReport } from './report.ts';

type ProviderFactory = (tier: AiTier, env: NodeJS.ProcessEnv) => EvalProvider;

/**
 * Providers the CLI can construct. `fake` and `anthropic` go through `AiClient` from
 * `@listora/ai`, so the AI settings in `.env.example` apply (models, daily budget, kill
 * switch); usage is metered in memory and reported as cost per item.
 */
const PROVIDERS: Readonly<Record<string, ProviderFactory | null>> = {
  fake: (tier, env) => {
    const config = loadAiConfig({ ...env, AI_PROVIDER: 'fake' });
    return new AiEvalProvider({
      id: 'fake',
      description:
        `fake AI provider: fixture answers from the corpus ground truth, metered at ` +
        `${config.models[tier]} prices; no network`,
      client: createAiClient(config, {
        usageStore: new InMemoryUsageStore(),
        provider: new FakeAiProvider({ fixtures: directoryFixtures(DEFAULT_FAKE_FIXTURES_DIR) }),
      }),
      tier,
    });
  },
  anthropic: (tier, env) => {
    const config = loadAiConfig({ ...env, AI_PROVIDER: 'anthropic' });
    return new AiEvalProvider({
      id: 'anthropic',
      description: `Anthropic API: ${config.models[tier]} (${tier} tier)`,
      client: createAiClient(config, { usageStore: new InMemoryUsageStore() }),
      tier,
    });
  },
  stub: () => new StubProvider(),
  none: null,
};

const USAGE = `Usage: npm run eval -- [options]

Options:
  --provider <name>     ${Object.keys(PROVIDERS).join(' | ')} (default: fake)
  --tier <tier>         ${AI_TIERS.join(' | ')} (default: standard); the AI tier for fake and anthropic
  --corpus <dir>        corpus directory (default: packages/eval/corpus)
  --min-accuracy <n>    exit 1 if any field of any system scores below n (0 to 1)
  --mismatches          list every item and field that was scored wrong
  --json                print the full report as JSON
  --help                show this message
`;

class UsageError extends Error {}

async function main(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      provider: { type: 'string', default: 'fake' },
      tier: { type: 'string', default: 'standard' },
      corpus: { type: 'string', default: DEFAULT_CORPUS_DIR },
      'min-accuracy': { type: 'string' },
      mismatches: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!Object.hasOwn(PROVIDERS, values.provider)) {
    throw new UsageError(`unknown provider "${values.provider}"`);
  }
  const tier = AI_TIERS.find((known) => known === values.tier);
  if (tier === undefined) throw new UsageError(`unknown tier "${values.tier}"`);
  const minAccuracy = parseThreshold(values['min-accuracy']);
  const createProvider = PROVIDERS[values.provider] ?? null;
  const provider = createProvider?.(tier, process.env);

  const corpus = await loadCorpus(values.corpus, { verifyImages: true });
  const report = await runEval(corpus, provider ? { provider } : {});
  process.stdout.write(
    values.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : formatReport(report, { mismatches: values.mismatches }),
  );

  let status = 0;
  for (const system of report.systems) {
    if (system.errors.length > 0) {
      process.stderr.write(`${system.id}: ${String(system.errors.length)} provider calls failed\n`);
      status = 1;
    }
    if (minAccuracy !== undefined && system.minFieldAccuracy < minAccuracy) {
      process.stderr.write(
        `${system.id}: lowest field accuracy ${(system.minFieldAccuracy * 100).toFixed(1)}% ` +
          `is below --min-accuracy ${(minAccuracy * 100).toFixed(1)}%\n`,
      );
      status = 1;
    }
  }
  return status;
}

function parseThreshold(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new UsageError('--min-accuracy must be a number from 0 to 1');
  }
  return value;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const usage =
    error instanceof UsageError ||
    (error as { code?: unknown }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION';
  process.stderr.write(`eval: ${error instanceof Error ? error.message : String(error)}\n`);
  if (usage) process.stderr.write(`\n${USAGE}`);
  process.exitCode = usage ? 2 : 1;
}
