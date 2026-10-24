import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LICENSES_FILE, auditCorpusLicenses, readLicenseManifest } from './licenses.ts';
import { DEFAULT_CORPUS_DIR, toJson } from './store.ts';

const photo = {
  file: 'photos/denim-care-label.jpg',
  title: 'Denim care label',
  author: 'A. Photographer',
  source: 'https://example.org/photos/denim-care-label',
  license: 'CC-BY-4.0',
};

describe('committed corpus licenses', () => {
  it('parses, and covers every file that the corpus generator does not write', async () => {
    const licenses = await readLicenseManifest(DEFAULT_CORPUS_DIR);
    expect(licenses.authored).toContain(LICENSES_FILE);
    expect(await auditCorpusLicenses(DEFAULT_CORPUS_DIR)).toEqual({ unlisted: [], missing: [] });
  });
});

describe('auditCorpusLicenses', () => {
  let dir: string;

  const writeLicenses = async (thirdParty: unknown[]): Promise<void> => {
    const path = join(dir, LICENSES_FILE);
    const licenses = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    await writeFile(path, toJson({ ...licenses, thirdParty }));
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'listora-corpus-licenses-'));
    await cp(DEFAULT_CORPUS_DIR, dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('flags a file that has no license manifest entry until one is added', async () => {
    await mkdir(join(dir, 'photos'));
    await writeFile(join(dir, photo.file), 'jpeg');
    expect(await auditCorpusLicenses(dir)).toEqual({ unlisted: [photo.file], missing: [] });

    await writeLicenses([photo]);
    expect(await auditCorpusLicenses(dir)).toEqual({ unlisted: [], missing: [] });
  });

  it('flags an entry whose file is not in the corpus', async () => {
    await writeLicenses([photo]);
    expect(await auditCorpusLicenses(dir)).toEqual({ unlisted: [], missing: [photo.file] });
  });

  it.each([
    [{ ...photo, license: 'CC-BY-NC-4.0' }, /license must be one of/],
    [{ ...photo, license: undefined }, /license must be one of/],
    [{ ...photo, author: '' }, /author must be a non-empty string/],
    [{ ...photo, source: 'somewhere online' }, /source must be a URL/],
  ])(
    'rejects a third-party entry that is not openly licensed and attributed',
    async (entry, error) => {
      await writeLicenses([entry]);
      await expect(readLicenseManifest(dir)).rejects.toThrow(error);
    },
  );

  it('rejects a manifest with the wrong shape', async () => {
    await writeFile(join(dir, LICENSES_FILE), toJson({ thirdParty: [] }));
    await expect(readLicenseManifest(dir)).rejects.toThrow(/authored must be a list/);
  });
});
