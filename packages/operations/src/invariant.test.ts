/**
 * The never-false-success invariant (docs/architecture.md section 1) as a check on the code
 * itself: only transitions.ts may change an operation's row, it sets `succeeded` only with a
 * `SuccessProof`, and only evidence.ts can create one. A new code path that writes operation
 * status directly fails this test. The seller's answers to offers, which are not operations, set
 * their own evidence only after a read-back of the offer shows the answer.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Every runtime TypeScript file of the backend workspaces (tests and test helpers excluded). */
function runtimeSources(): { path: string; text: string }[] {
  const files: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== 'node_modules' && name !== '.tsbuild') walk(path);
        continue;
      }
      const isTest =
        name.endsWith('.test.ts') || name === 'test-support.ts' || name === 'testing.ts';
      if (name.endsWith('.ts') && !isTest) {
        files.push({ path: relative(ROOT, path), text: readFileSync(path, 'utf8') });
      }
    }
  };
  for (const group of ['apps', 'packages']) {
    for (const workspace of readdirSync(join(ROOT, group))) {
      const src = join(ROOT, group, workspace, 'src');
      if (statSync(join(ROOT, group, workspace)).isDirectory() && existsDir(src)) walk(src);
    }
  }
  return files;
}

function existsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const TRANSITIONS = 'packages/operations/src/transitions.ts';
const EVIDENCE = 'packages/operations/src/evidence.ts';
const SCHEMA = 'packages/db/src/schema.ts';
/** The seller's answers to offers keep their own evidence (docs/features/offers.md). */
const OFFER_ANSWERS = 'packages/automation/src/offers/answer.ts';

describe('never-false-success invariant in the code', () => {
  const sources = runtimeSources();

  it('finds the engine sources', () => {
    expect(sources.map((file) => file.path)).toEqual(
      expect.arrayContaining([TRANSITIONS, EVIDENCE, 'packages/operations/src/executor.ts']),
    );
  });

  it('changes marketplace_operation rows only in transitions.ts', () => {
    const writers = sources
      .filter(
        (file) =>
          /updateTable\(\s*['"]marketplace_operation['"]/.test(file.text) ||
          /\bupdate\s+marketplace_operation\b/i.test(file.text) ||
          /\bdelete\s+from\s+marketplace_operation\b/i.test(file.text) ||
          /deleteFrom\(\s*['"]marketplace_operation['"]/.test(file.text),
      )
      .map((file) => file.path);
    expect(writers).toEqual([TRANSITIONS]);
  });

  it('sets success evidence only in transitions.ts, and only from a proof', () => {
    // schema.ts only declares the column's type.
    const setters = sources
      .filter((file) => file.path !== SCHEMA && /success_evidence\s*:/.test(file.text))
      .map((file) => file.path);
    expect(setters).toEqual([OFFER_ANSWERS, TRANSITIONS]);
    // An offer answer's evidence is set in one place: right after a read-back that shows it.
    const answers = sources.find((file) => file.path === OFFER_ANSWERS)?.text ?? '';
    expect(answers.match(/evidence: true/g)).toHaveLength(1);
    expect(answers).toMatch(
      /answerShown\(prepared\.request, state\)\) \{\s*await update\(\{ status: 'succeeded', sent: true, evidence: true \}\)/,
    );
    const transitions = sources.find((file) => file.path === TRANSITIONS)?.text ?? '';
    expect(transitions).toMatch(/success_evidence: change\.proof\.evidence/);
    expect(transitions.match(/success_evidence\s*:/g)).toHaveLength(2); // the proof, or null
  });

  it('creates success proofs only in evidence.ts', () => {
    const casts = sources
      .filter((file) => /as\s+(unknown\s+as\s+)?SuccessProof\b/.test(file.text))
      .map((file) => file.path);
    expect(casts).toEqual([EVIDENCE]);
  });

  it('inserts operations only through enqueueOperation, which never sets a status', () => {
    const inserters = sources.filter((file) =>
      /insertInto\(\s*['"]marketplace_operation['"]/.test(file.text),
    );
    expect(inserters.map((file) => file.path)).toEqual(['packages/operations/src/commands.ts']);
    const insert =
      /insertInto\(\s*'marketplace_operation'\s*\)[\s\S]*?\.values\(\{([\s\S]*?)\}\)/.exec(
        inserters[0]?.text ?? '',
      );
    expect(insert?.[1]).toBeDefined();
    expect(insert?.[1]).not.toMatch(/\bstatus\s*:|success_evidence/);
  });
});
