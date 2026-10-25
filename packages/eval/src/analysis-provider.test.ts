import { describe, expect, it } from 'vitest';

import {
  AiClient,
  createModelRegistry,
  CURRENT_PRICE_TABLE,
  directoryFixtures,
  FakeAiProvider,
  InMemoryUsageStore,
  inMemoryFixtures,
  staticKillSwitch,
  type FixtureSource,
} from '@listora/ai';
import {
  encodeAnalysisAnswer,
  ITEM_ANALYSIS_OUTPUT,
  ITEM_ANALYSIS_OUTPUT_NAME,
} from '@listora/analysis';

import {
  ANALYSIS_FIELDS,
  AnalysisEvalProvider,
  analysisInput,
  fakeAnalysisAnswer,
  tagValuesOf,
} from './analysis-provider.ts';
import { DEFAULT_CORPUS_DIR, imagePath, loadCorpus } from './corpus/store.ts';
import { DEFAULT_FAKE_FIXTURES_DIR } from './fake-fixtures.ts';
import { runEval } from './harness.ts';
import type { EvalProviderInput } from './provider.ts';

const corpus = await loadCorpus(DEFAULT_CORPUS_DIR);

function analysisProvider(
  fixtures: FixtureSource,
  options: { tier?: 'standard' | 'premium' } = {},
) {
  const store = new InMemoryUsageStore();
  const provider = new AnalysisEvalProvider({
    id: 'fake',
    description: 'item analysis on the fake AI provider, for tests',
    client: new AiClient({
      provider: new FakeAiProvider({ fixtures }),
      registry: createModelRegistry({}, CURRENT_PRICE_TABLE),
      usageStore: store,
      killSwitch: staticKillSwitch(false),
      dailyBudgetMicros: 1_000_000,
    }),
    tier: options.tier ?? 'standard',
  });
  return { provider, store };
}

function caseInput(index: number): EvalProviderInput {
  const corpusCase = corpus.cases[index];
  if (corpusCase === undefined) throw new Error('corpus is too small');
  return {
    caseId: corpusCase.id,
    image: {
      path: imagePath(corpus, corpusCase),
      mediaType: corpusCase.image.mediaType,
      width: corpusCase.image.width,
      height: corpusCase.image.height,
    },
    ocr: corpusCase.ocr,
    parsed: { rn: [], ca: [], gtin: [], size: [], fiber: [], origin: [], style: [] },
  };
}

describe('fake item_analysis fixtures', () => {
  it('fit the strict analysis schema for every corpus case', () => {
    for (const corpusCase of corpus.cases) {
      const parsed = ITEM_ANALYSIS_OUTPUT.schema.safeParse(
        encodeAnalysisAnswer(fakeAnalysisAnswer(corpusCase.id, corpusCase.truth)),
      );
      expect(parsed.error, corpusCase.id).toBeUndefined();
    }
  });
});

describe('AnalysisEvalProvider', () => {
  // The whole corpus through the production analysis: seconds of work on a busy machine.
  it('runs the production analysis on every case, scored on the tag facts it reports', async () => {
    const { provider, store } = analysisProvider(directoryFixtures(DEFAULT_FAKE_FIXTURES_DIR));
    const report = await runEval(corpus, { providers: [provider] });
    const system = report.systems[1];
    expect(system?.id).toBe('analysis:fake');
    expect(system?.scoredFields).toEqual(ANALYSIS_FIELDS);
    expect(system?.scoring).toBe('one_of');
    expect(Object.keys(system?.fields ?? {})).toEqual([...ANALYSIS_FIELDS]);
    expect(system?.errors).toEqual([]);
    expect(system?.minFieldAccuracy).toBe(1);
    // One metered analysis call per case, at Haiku prices, with its purpose.
    expect(store.events).toHaveLength(corpus.cases.length);
    expect(store.events.every((event) => event.purpose === 'item_analysis')).toBe(true);
    const total = store.events.reduce((sum, event) => sum + event.costMicros, 0);
    expect(system?.costMicrosTotal).toBe(total);
    expect(system?.costMicrosPerItem).toBeGreaterThan(0);
  }, 30_000);

  it('meters the premium tier at its own prices', async () => {
    const small = { ...corpus, cases: corpus.cases.slice(0, 3) };
    const fixtures = directoryFixtures(DEFAULT_FAKE_FIXTURES_DIR);
    const standard = await runEval(small, { providers: [analysisProvider(fixtures).provider] });
    const premium = await runEval(small, {
      providers: [analysisProvider(fixtures, { tier: 'premium' }).provider],
    });
    expect(premium.systems[1]?.costMicrosTotal).toBeGreaterThan(
      (standard.systems[1]?.costMicrosTotal ?? 0) * 10,
    );
  });

  it('counts a schema-violating answer as a failed, billed analysis after its one retry', async () => {
    const input = await analysisInput(caseInput(0));
    const corpusCase = corpus.cases[0];
    if (corpusCase === undefined) throw new Error('corpus is empty');
    const answer = fakeAnalysisAnswer(corpusCase.id, corpusCase.truth);
    const broken = {
      ...answer,
      variants: { ...answer.variants, ebay: { title: 'x'.repeat(81), description: 'd' } },
    };
    const { provider, store } = analysisProvider(
      inMemoryFixtures({
        [input.photoSetHash]: {
          outputs: { [ITEM_ANALYSIS_OUTPUT_NAME]: encodeAnalysisAnswer(broken) },
        },
      }),
    );
    const report = await runEval({ ...corpus, cases: [corpusCase] }, { providers: [provider] });
    const system = report.systems[1];
    expect(system?.errors).toEqual([
      {
        caseId: corpusCase.id,
        message: expect.stringMatching(
          /^invalid_output: The AI gave an unusable answer twice in a row\. Try again\. \(AI call failed \(invalid_output\): .*variants/s,
        ) as unknown,
      },
    ]);
    expect(store.events.map((event) => event.errorCode)).toEqual([
      'invalid_output',
      'invalid_output',
    ]);
    expect(system?.costMicrosTotal).toBe(
      store.events.reduce((sum, event) => sum + event.costMicros, 0),
    );
  });

  it('turns a corpus case into an item with one tag photo read on the phone', async () => {
    const input = await analysisInput(caseInput(0));
    expect(input.photos).toHaveLength(1);
    expect(input.photos[0]).toMatchObject({ role: 'tag', photoId: corpus.cases[0]?.id });
    expect(input.photos[0]?.ocrLines.length).toBe(corpus.cases[0]?.ocr.lines.length);
  });

  it('reads the tag facts back out of a result', () => {
    expect(
      tagValuesOf({
        details: {
          rnNumber: { value: '12345', confidence: 1, provenance: 'ocr' },
          upc: { value: '0036000291452', confidence: 1, provenance: 'barcode' },
          sizeLabel: { value: 'M', confidence: 1, provenance: 'ocr' },
          sizeSystem: { value: 'letter', confidence: 1, provenance: 'ocr' },
        },
        variants: [],
        needsEscalation: false,
      }),
    ).toEqual({
      rn: ['12345'],
      gtin: [{ format: 'upc_a', digits: '036000291452' }],
      size: [{ system: 'letter', value: 'M' }],
      style: [],
    });
  });
});
