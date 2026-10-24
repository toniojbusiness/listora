import { existsSync } from 'node:fs';

import { beforeAll, describe, expect, it } from 'vitest';

import { TAG_FIELDS } from '@listora/tag-parse';

import { DEFAULT_CORPUS_DIR, loadCorpus, type LoadedCorpus } from './corpus/store.ts';
import { runEval } from './harness.ts';
import { StubProvider, type EvalProvider, type EvalProviderInput } from './provider.ts';

/** Acceptance threshold from plan task T-09. */
const REQUIRED_ACCURACY = 0.95;

let corpus: LoadedCorpus;

beforeAll(async () => {
  corpus = await loadCorpus(DEFAULT_CORPUS_DIR, { verifyImages: true });
});

describe('deterministic parsers on the synthetic corpus', () => {
  it(`score at least ${String(REQUIRED_ACCURACY * 100)}% on every field`, async () => {
    const report = await runEval(corpus);
    const [parsers] = report.systems;
    expect(report.systems).toHaveLength(1);
    expect(parsers?.id).toBe('parsers');
    expect(report.corpus.items).toBeGreaterThanOrEqual(200);
    for (const field of TAG_FIELDS) {
      const metrics = parsers?.fields[field];
      expect(metrics?.items, field).toBe(report.corpus.items);
      expect(metrics?.accuracy, field).toBeGreaterThanOrEqual(REQUIRED_ACCURACY);
    }
    expect(parsers?.overallAccuracy).toBeGreaterThanOrEqual(REQUIRED_ACCURACY);
    expect(parsers?.costMicrosTotal).toBe(0);
  });

  it('report no false positives: every value they return is on the tag', async () => {
    const [parsers] = (await runEval(corpus)).systems;
    for (const field of TAG_FIELDS) expect(parsers?.fields[field].falsePositives, field).toBe(0);
  });
});

describe('runEval with a provider', () => {
  it('scores the stub provider and reports its cost per item', async () => {
    const report = await runEval(corpus, {
      provider: new StubProvider({ costMicrosPerItem: 1500 }),
    });
    const [parsers, stub] = report.systems;
    expect(stub?.id).toBe('provider:stub');
    expect(stub?.fields).toEqual(parsers?.fields);
    expect(stub?.costMicrosPerItem).toBe(1500);
    expect(stub?.costMicrosTotal).toBe(1500 * report.corpus.items);
    expect(stub?.errors).toEqual([]);
  });

  it('gives the provider the tag image, the OCR reads, and the parsed facts', async () => {
    const inputs: EvalProviderInput[] = [];
    const recording: EvalProvider = {
      id: 'recording',
      description: 'records inputs',
      extract: async (input) => {
        inputs.push(input);
        return { values: {}, usage: { costMicros: 0 } };
      },
    };
    await runEval(corpus, { provider: recording });
    expect(inputs).toHaveLength(corpus.cases.length);
    const [first] = inputs;
    expect(first?.caseId).toBe(corpus.cases[0]?.id);
    expect(first?.image.mediaType).toBe('image/png');
    expect(existsSync(first?.image.path ?? '')).toBe(true);
    expect(first?.ocr).toEqual(corpus.cases[0]?.ocr);
    expect(first?.parsed.rn).toBeDefined();
  });

  it('records a failed provider call as an error and scores it as no answer', async () => {
    let calls = 0;
    const flaky: EvalProvider = {
      id: 'flaky',
      description: 'fails every other call',
      extract: async (input) => {
        calls += 1;
        if (calls % 2 === 0) throw new Error('upstream 503');
        return new StubProvider().extract(input);
      },
    };
    const report = await runEval(corpus, { provider: flaky });
    const [parsers, provider] = report.systems;
    expect(provider?.errors).toHaveLength(Math.floor(report.corpus.items / 2));
    expect(provider?.errors[0]).toEqual({ caseId: corpus.cases[1]?.id, message: 'upstream 503' });
    expect(provider?.overallAccuracy).toBeLessThan(parsers?.overallAccuracy ?? 0);
  });

  it('rejects a provider that reports an invalid cost', async () => {
    const badCost: EvalProvider = {
      id: 'bad-cost',
      description: 'reports fractional micro-dollars',
      extract: async () => ({ values: {}, usage: { costMicros: 0.5 } }),
    };
    const [, provider] = (await runEval(corpus, { provider: badCost })).systems;
    expect(provider?.errors).toHaveLength(corpus.cases.length);
    expect(provider?.errors[0]?.message).toMatch(/invalid costMicros/);
    expect(provider?.costMicrosTotal).toBe(0);
  });
});
