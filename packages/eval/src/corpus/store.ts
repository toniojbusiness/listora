import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TAG_FIELDS } from '@listora/tag-parse';

import { DEFAULT_SEED, GENERATOR_VERSION, buildCorpusSpecs } from './generate.ts';
import { decodePng, encodePng, pixelSha256, type Raster } from './png.ts';
import { renderTag } from './render.ts';
import type { CaseSpec, CorpusCase, CorpusManifest } from './types.ts';

/** The committed corpus: `manifest.json` plus `tags/<id>.json` and `tags/<id>.png`. */
export const DEFAULT_CORPUS_DIR = fileURLToPath(new URL('../../corpus', import.meta.url));

export const MANIFEST_FILE = 'manifest.json';
export const TAGS_DIR = 'tags';

export interface RenderedCase {
  readonly corpusCase: CorpusCase;
  readonly raster: Raster;
}

export function renderCase(spec: CaseSpec): RenderedCase {
  const raster = renderTag(spec.printed, spec.kind);
  const corpusCase: CorpusCase = {
    ...spec,
    image: {
      file: `${spec.id}.png`,
      mediaType: 'image/png',
      width: raster.width,
      height: raster.height,
      pixelSha256: pixelSha256(raster),
    },
  };
  return { corpusCase, raster };
}

export function buildManifest(cases: readonly CorpusCase[], seed = DEFAULT_SEED): CorpusManifest {
  return {
    name: 'listora-synthetic-tags',
    generatorVersion: GENERATOR_VERSION,
    seed,
    regenerate: 'npm run corpus:render --workspace @listora/eval',
    cases: cases.map((corpusCase) => corpusCase.id),
  };
}

/** Regenerates the corpus directory from the seed, replacing every file it manages. */
export async function writeCorpus(dir = DEFAULT_CORPUS_DIR, seed = DEFAULT_SEED): Promise<number> {
  const tagsDir = join(dir, TAGS_DIR);
  await rm(tagsDir, { recursive: true, force: true });
  await mkdir(tagsDir, { recursive: true });
  const rendered = buildCorpusSpecs(seed).map(renderCase);
  for (const { corpusCase, raster } of rendered) {
    await writeFile(join(tagsDir, `${corpusCase.id}.json`), toJson(corpusCase));
    await writeFile(join(tagsDir, corpusCase.image.file), encodePng(raster));
  }
  await writeFile(
    join(dir, MANIFEST_FILE),
    toJson(
      buildManifest(
        rendered.map(({ corpusCase }) => corpusCase),
        seed,
      ),
    ),
  );
  return rendered.length;
}

export interface LoadedCorpus {
  readonly dir: string;
  readonly manifest: CorpusManifest;
  readonly cases: readonly CorpusCase[];
}

/**
 * Loads and validates a corpus directory. Fails loudly on a missing or extra file, an id
 * mismatch, or an image whose pixels do not match its recorded hash.
 */
export async function loadCorpus(
  dir = DEFAULT_CORPUS_DIR,
  options: { verifyImages?: boolean } = {},
): Promise<LoadedCorpus> {
  const manifestPath = join(dir, MANIFEST_FILE);
  const manifest = parseManifest(JSON.parse(await readFile(manifestPath, 'utf8')), manifestPath);
  const tagsDir = join(dir, TAGS_DIR);
  const expected = new Set(manifest.cases.flatMap((id) => [`${id}.json`, `${id}.png`]));
  const present = new Set(await readdir(tagsDir));
  const missing = [...expected].filter((file) => !present.has(file));
  const extra = [...present].filter((file) => !expected.has(file));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `corpus files do not match the manifest (missing: ${missing.join(', ') || 'none'}; ` +
        `unexpected: ${extra.join(', ') || 'none'})`,
    );
  }
  const cases: CorpusCase[] = [];
  for (const id of manifest.cases) {
    const casePath = join(tagsDir, `${id}.json`);
    const corpusCase = parseCase(JSON.parse(await readFile(casePath, 'utf8')), casePath);
    if (corpusCase.id !== id) throw new Error(`${casePath} declares id ${corpusCase.id}`);
    if (options.verifyImages === true) {
      const raster = decodePng(await readFile(join(tagsDir, corpusCase.image.file)));
      if (pixelSha256(raster) !== corpusCase.image.pixelSha256) {
        throw new Error(`${corpusCase.image.file} does not match its recorded pixel hash`);
      }
    }
    cases.push(corpusCase);
  }
  return { dir, manifest, cases };
}

function parseManifest(json: unknown, path: string): CorpusManifest {
  if (
    !isRecord(json) ||
    json['name'] !== 'listora-synthetic-tags' ||
    typeof json['generatorVersion'] !== 'number' ||
    typeof json['seed'] !== 'number' ||
    !isStringArray(json['cases'])
  ) {
    throw new Error(`${path} is not a Listora tag corpus manifest`);
  }
  return json as unknown as CorpusManifest;
}

/** Checks the fields the harness relies on; the generator owns the rest of the shape. */
function parseCase(json: unknown, path: string): CorpusCase {
  const image = isRecord(json) ? json['image'] : undefined;
  const ocr = isRecord(json) ? json['ocr'] : undefined;
  const truth = isRecord(json) ? json['truth'] : undefined;
  const valid =
    isRecord(json) &&
    typeof json['id'] === 'string' &&
    isRecord(image) &&
    typeof image['file'] === 'string' &&
    typeof image['pixelSha256'] === 'string' &&
    isRecord(ocr) &&
    Array.isArray(ocr['lines']) &&
    Array.isArray(ocr['barcodes']) &&
    isRecord(truth) &&
    TAG_FIELDS.every((field) => Array.isArray(truth[field]));
  if (!valid) throw new Error(`${path} is not a corpus case`);
  return json as unknown as CorpusCase;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function imagePath(corpus: LoadedCorpus, corpusCase: CorpusCase): string {
  return join(corpus.dir, TAGS_DIR, corpusCase.image.file);
}

/** Stable JSON: two-space indent and a trailing newline, as committed. */
export function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
