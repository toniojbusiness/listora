import { cp, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildCorpusSpecs } from './generate.ts';
import { decodePng, encodePng } from './png.ts';
import {
  DEFAULT_CORPUS_DIR,
  MANIFEST_FILE,
  TAGS_DIR,
  buildManifest,
  loadCorpus,
  renderCase,
  toJson,
} from './store.ts';

describe('committed corpus', () => {
  // Decoding and hashing every image is CPU-bound, so give it headroom on a loaded machine.
  it(
    'matches the generator exactly (run `npm run corpus:render` after generator changes)',
    { timeout: 30_000 },
    async () => {
      const corpus = await loadCorpus(DEFAULT_CORPUS_DIR, { verifyImages: true });
      const expected = buildCorpusSpecs().map((spec) => renderCase(spec).corpusCase);
      expect(corpus.manifest).toEqual(buildManifest(expected));
      expect(corpus.cases).toEqual(expected);
    },
  );
});

describe('loadCorpus', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'listora-corpus-'));
    await cp(DEFAULT_CORPUS_DIR, dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads a valid copy', async () => {
    const corpus = await loadCorpus(dir, { verifyImages: true });
    expect(corpus.cases.length).toBe(corpus.manifest.cases.length);
  });

  it('fails when a listed file is missing or an unlisted file is present', async () => {
    const [first] = (await loadCorpus(dir)).manifest.cases;
    await unlink(join(dir, TAGS_DIR, `${String(first)}.png`));
    await writeFile(join(dir, TAGS_DIR, 'stray.json'), '{}');
    await expect(loadCorpus(dir)).rejects.toThrow(/missing: .*\.png; unexpected: stray\.json/);
  });

  it('fails when an image no longer matches its recorded pixels', async () => {
    const [first] = (await loadCorpus(dir)).cases;
    if (first === undefined) throw new Error('empty corpus');
    const path = join(dir, TAGS_DIR, first.image.file);
    const raster = decodePng(await readFile(path));
    raster.pixels[0] = (raster.pixels[0] ?? 0) ^ 0xff;
    await writeFile(path, encodePng(raster));
    await expect(loadCorpus(dir, { verifyImages: true })).rejects.toThrow(/pixel hash/);
  });

  it('fails on a manifest or case file with the wrong shape', async () => {
    const manifestPath = join(dir, MANIFEST_FILE);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    await writeFile(manifestPath, toJson({ ...manifest, name: 'something-else' }));
    await expect(loadCorpus(dir)).rejects.toThrow(/not a Listora tag corpus manifest/);

    await writeFile(manifestPath, toJson(manifest));
    const [id] = manifest['cases'] as string[];
    await writeFile(join(dir, TAGS_DIR, `${String(id)}.json`), toJson({ id, truth: {} }));
    await expect(loadCorpus(dir)).rejects.toThrow(/is not a corpus case/);
  });

  it('fails when a case file declares a different id', async () => {
    const corpus = await loadCorpus(dir);
    const [first] = corpus.cases;
    if (first === undefined) throw new Error('empty corpus');
    await writeFile(join(dir, TAGS_DIR, `${first.id}.json`), toJson({ ...first, id: 'other' }));
    await expect(loadCorpus(dir)).rejects.toThrow(/declares id other/);
  });
});
