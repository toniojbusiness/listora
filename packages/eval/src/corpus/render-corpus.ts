// Regenerates packages/eval/corpus from the seed. Run after changing the generator, noise
// model, font, or renderer (and bump GENERATOR_VERSION):
//   npm run corpus:render --workspace @listora/eval
import { DEFAULT_CORPUS_DIR, writeCorpus } from './store.ts';

const count = await writeCorpus(DEFAULT_CORPUS_DIR);
process.stdout.write(`Wrote ${String(count)} synthetic tags to ${DEFAULT_CORPUS_DIR}\n`);
