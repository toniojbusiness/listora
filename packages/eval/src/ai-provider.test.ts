import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  AiClient,
  createModelRegistry,
  CURRENT_PRICE_TABLE,
  directoryFixtures,
  FakeAiProvider,
  InMemoryUsageStore,
  inMemoryFixtures,
  photoSetHashOfImages,
  staticKillSwitch,
  type FixtureSource,
} from '@listora/ai';

import { AiEvalProvider, TAG_VALUES_OUTPUT, tagPrompt } from './ai-provider.ts';
import { DEFAULT_CORPUS_DIR, imagePath, loadCorpus } from './corpus/store.ts';
import { buildFakeFixtures, DEFAULT_FAKE_FIXTURES_DIR, listFakeFixtures } from './fake-fixtures.ts';
import { runEval } from './harness.ts';

const corpus = await loadCorpus(DEFAULT_CORPUS_DIR);

function evalProvider(
  fixtures: FixtureSource,
  options: { dailyBudgetMicros?: number; killSwitch?: boolean } = {},
) {
  const store = new InMemoryUsageStore();
  const provider = new AiEvalProvider({
    id: 'fake',
    description: 'fake AI provider for tests',
    client: new AiClient({
      provider: new FakeAiProvider({ fixtures }),
      registry: createModelRegistry({}, CURRENT_PRICE_TABLE),
      usageStore: store,
      killSwitch: staticKillSwitch(options.killSwitch ?? false),
      dailyBudgetMicros: options.dailyBudgetMicros ?? 1_000_000,
    }),
    tier: 'standard',
  });
  return { provider, store };
}

async function hashOf(caseIndex: number): Promise<string> {
  const corpusCase = corpus.cases[caseIndex];
  if (corpusCase === undefined) throw new Error('corpus is too small');
  const data = new Uint8Array(await readFile(imagePath(corpus, corpusCase)));
  return photoSetHashOfImages([{ data }]);
}

describe('committed fake AI fixtures', () => {
  it('match the corpus exactly (run `npm run corpus:render` after corpus changes)', async () => {
    const expected = await buildFakeFixtures(corpus);
    expect(await listFakeFixtures()).toEqual([...expected.keys()].sort());
    const source = directoryFixtures(DEFAULT_FAKE_FIXTURES_DIR);
    for (const [file, fixture] of expected) {
      expect(await source.load(file.replace(/\.json$/, ''))).toEqual(fixture);
    }
  });

  it('fit the tag_values schema for every corpus case', () => {
    for (const corpusCase of corpus.cases) {
      expect(TAG_VALUES_OUTPUT.schema.safeParse(corpusCase.truth).success).toBe(true);
    }
  });
});

describe('AiEvalProvider', () => {
  it('scores the corpus through AiClient and reports the metered cost per item', async () => {
    const { provider, store } = evalProvider(directoryFixtures(DEFAULT_FAKE_FIXTURES_DIR));
    const report = await runEval(corpus, { providers: [provider] });
    const system = report.systems[1];
    expect(system?.id).toBe('provider:fake');
    expect(system?.errors).toEqual([]);
    expect(system?.overallAccuracy).toBe(1);

    expect(store.events).toHaveLength(corpus.cases.length);
    const metered = store.events.reduce((sum, event) => sum + event.costMicros, 0);
    expect(metered).toBeGreaterThan(0);
    expect(system?.costMicrosTotal).toBe(metered);
    expect(store.events[0]).toMatchObject({
      accountId: 'eval',
      purpose: 'tag_eval',
      tier: 'standard',
      model: 'claude-haiku-5-5',
      images: 1,
      outcome: 'succeeded',
    });
  });

  it('counts the billed cost of a failed call in the report', async () => {
    const [first, second] = [await hashOf(0), await hashOf(1)];
    const fixtures = inMemoryFixtures({
      [first]: { outputs: { tag_values: corpus.cases[0]?.truth } },
      // A billed failure: 1,000 input and 2,000 output tokens at Haiku prices = 1,100 micros.
      [second]: {
        error: { code: 'truncated' },
        usage: { inputTokens: 1_000, outputTokens: 2_000 },
      },
    });
    const { provider, store } = evalProvider(fixtures);
    const small = { ...corpus, cases: corpus.cases.slice(0, 2) };
    const report = await runEval(small, { providers: [provider] });
    const system = report.systems[1];

    expect(system?.errors).toEqual([
      { caseId: corpus.cases[1]?.id, message: expect.stringContaining('truncated') as unknown },
    ]);
    const succeeded = store.events[0]?.costMicros ?? 0;
    expect(store.events.map((event) => event.outcome)).toEqual(['succeeded', 'failed']);
    expect(store.events[1]?.costMicros).toBe(1_100);
    expect(system?.costMicrosTotal).toBe(succeeded + 1_100);
  });

  it('reports a call refused by a budget guard as an unbilled failure', async () => {
    const { provider, store } = evalProvider(directoryFixtures(DEFAULT_FAKE_FIXTURES_DIR), {
      killSwitch: true,
    });
    const report = await runEval(
      { ...corpus, cases: corpus.cases.slice(0, 1) },
      { providers: [provider] },
    );
    expect(report.systems[1]?.errors[0]?.message).toContain('kill switch');
    expect(report.systems[1]?.costMicrosTotal).toBe(0);
    expect(store.events).toEqual([]);
  });

  it('sends the OCR reads and parser facts as the per-item prompt', () => {
    const prompt = JSON.parse(
      tagPrompt({
        caseId: 'x',
        image: { path: 'unused', mediaType: 'image/png', width: 1, height: 1 },
        ocr: { lines: [{ text: 'RN 141526', confidence: 0.9 }], barcodes: [{ payload: '012' }] },
        parsed: {
          rn: [
            {
              value: '141526',
              confidence: 0.9,
              source: { kind: 'ocr', lineIndexes: [0], text: 'RN 141526' },
            },
          ],
          ca: [],
          gtin: [],
          size: [],
          fiber: [],
          origin: [],
          style: [],
        },
      }),
    ) as unknown;
    expect(prompt).toEqual({
      ocrLines: ['RN 141526'],
      barcodes: ['012'],
      parserFacts: { rn: ['141526'], ca: [], gtin: [], size: [], fiber: [], origin: [], style: [] },
    });
  });
});
