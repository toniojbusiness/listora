// Regenerates packages/eval/corpus from the seed, and the fake AI provider's fixtures for it.
// Run after changing the generator, noise model, font, or renderer (and bump
// GENERATOR_VERSION):
//   npm run corpus:render --workspace @listora/eval
import { DEFAULT_FAKE_FIXTURES_DIR, writeFakeFixtures } from '../fake-fixtures.ts';
import { DEFAULT_CORPUS_DIR, loadCorpus, writeCorpus } from './store.ts';

const count = await writeCorpus(DEFAULT_CORPUS_DIR);
process.stdout.write(`Wrote ${String(count)} synthetic tags to ${DEFAULT_CORPUS_DIR}\n`);
const fixtures = await writeFakeFixtures(await loadCorpus(DEFAULT_CORPUS_DIR));
process.stdout.write(
  `Wrote ${String(fixtures)} fake AI fixtures to ${DEFAULT_FAKE_FIXTURES_DIR}\n`,
);
