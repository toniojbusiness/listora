import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkTargets,
  findDrift,
  generateTypeScript,
  writeTargets,
  type GenerationTarget,
} from './codegen.ts';

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'listora-codegen-test-'));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
}

/** A target that "generates" fixed files, standing in for the real generators. */
function fixedTarget(files: Record<string, string>): GenerationTarget {
  return { name: 'fixture', dir: 'out', generate: (outDir) => writeFiles(outDir, files) };
}

describe('findDrift', () => {
  it('reports nothing when the directories match', async () => {
    await writeFiles(join(scratch, 'a'), { 'x.swift': 'x', 'nested/y.swift': 'y' });
    await writeFiles(join(scratch, 'b'), { 'x.swift': 'x', 'nested/y.swift': 'y' });
    expect(await findDrift(join(scratch, 'a'), join(scratch, 'b'))).toEqual([]);
  });

  it('reports changed, missing, and unexpected files', async () => {
    await writeFiles(join(scratch, 'generated'), {
      'same.ts': '1',
      'edited.ts': 'new',
      'new.ts': 'n',
    });
    await writeFiles(join(scratch, 'committed'), {
      'same.ts': '1',
      'edited.ts': 'old',
      'stale.ts': 's',
    });
    expect(await findDrift(join(scratch, 'generated'), join(scratch, 'committed'))).toEqual([
      { path: 'edited.ts', kind: 'changed' },
      { path: 'new.ts', kind: 'missing' },
      { path: 'stale.ts', kind: 'unexpected' },
    ]);
  });

  it('treats a missing committed directory as every file missing', async () => {
    await writeFiles(join(scratch, 'generated'), { 'a.ts': 'a' });
    expect(await findDrift(join(scratch, 'generated'), join(scratch, 'absent'))).toEqual([
      { path: 'a.ts', kind: 'missing' },
    ]);
  });
});

describe('checkTargets and writeTargets', () => {
  const target = fixedTarget({ 'Client.swift': 'client v2', 'Types.swift': 'types v2' });

  it('detects a hand edit to committed generated code', async () => {
    await writeFiles(join(scratch, 'out'), {
      'Client.swift': 'client v2',
      'Types.swift': 'edited',
    });
    const [result] = await checkTargets([target], scratch);
    expect(result?.drift).toEqual([{ path: 'Types.swift', kind: 'changed' }]);
  });

  it('passes once the committed copy is regenerated, and removes stale files', async () => {
    await writeFiles(join(scratch, 'out'), { 'Client.swift': 'client v1', 'Old.swift': 'old' });
    await writeTargets([target], scratch);
    const [result] = await checkTargets([target], scratch);
    expect(result?.drift).toEqual([]);
    await expect(readFile(join(scratch, 'out/Old.swift'))).rejects.toThrow(/ENOENT/);
  });
});

describe('generateTypeScript', () => {
  it('matches the committed src/generated/openapi.ts (run `npm run contract:generate`)', async () => {
    await generateTypeScript(scratch);
    const fresh = await readFile(join(scratch, 'openapi.ts'), 'utf8');
    const committed = await readFile(
      join(import.meta.dirname, '../src/generated/openapi.ts'),
      'utf8',
    );
    expect(fresh === committed).toBe(true);
  });
});
