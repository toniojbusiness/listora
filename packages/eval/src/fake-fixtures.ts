import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { photoSetHashOfImages, type FakeFixture } from '@listora/ai';
import { encodeAnalysisAnswer, ITEM_ANALYSIS_OUTPUT_NAME } from '@listora/analysis';

import { TAG_VALUES_OUTPUT } from './ai-provider.ts';
import { fakeAnalysisAnswer } from './analysis-provider.ts';
import { imagePath, toJson, type LoadedCorpus } from './corpus/store.ts';

/**
 * Fixtures for `--provider fake`: one `<photo-set hash>.json` per corpus tag, answering the
 * `tag_values` schema (tag reading) and the `item_analysis` schema (the full analysis). They
 * are generated from the corpus ground truth, so the fake measures the plumbing (fixture
 * lookup, schema validation, provenance, metering, cost report), not a model.
 */
export const DEFAULT_FAKE_FIXTURES_DIR = fileURLToPath(
  new URL('../fixtures/fake-ai', import.meta.url),
);

/** The fixture files for a corpus, keyed by file name. */
export async function buildFakeFixtures(
  corpus: LoadedCorpus,
): Promise<ReadonlyMap<string, FakeFixture>> {
  const fixtures = new Map<string, FakeFixture>();
  for (const corpusCase of corpus.cases) {
    const data = new Uint8Array(await readFile(imagePath(corpus, corpusCase)));
    const file = `${photoSetHashOfImages([{ data }])}.json`;
    const fixture: FakeFixture = {
      description: `${corpusCase.id}: the corpus ground truth`,
      outputs: {
        [TAG_VALUES_OUTPUT.name]: corpusCase.truth,
        [ITEM_ANALYSIS_OUTPUT_NAME]: encodeAnalysisAnswer(
          fakeAnalysisAnswer(corpusCase.id, corpusCase.truth),
        ),
      },
    };
    if (fixtures.has(file)) throw new Error(`two corpus cases render the same image: ${file}`);
    fixtures.set(file, fixture);
  }
  return fixtures;
}

/** Replaces the fixture directory with fixtures for the corpus; returns how many it wrote. */
export async function writeFakeFixtures(
  corpus: LoadedCorpus,
  dir = DEFAULT_FAKE_FIXTURES_DIR,
): Promise<number> {
  const fixtures = await buildFakeFixtures(corpus);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const [file, fixture] of fixtures) await writeFile(join(dir, file), toJson(fixture));
  return fixtures.size;
}

/** The committed fixture file names, for the drift test. */
export async function listFakeFixtures(dir = DEFAULT_FAKE_FIXTURES_DIR): Promise<string[]> {
  return (await readdir(dir)).filter((file) => file.endsWith('.json')).sort();
}
