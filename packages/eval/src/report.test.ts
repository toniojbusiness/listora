import { describe, expect, it } from 'vitest';

import { TAG_FIELDS, type TagField } from '@listora/tag-parse';

import type { EvalReport, FieldReport, SystemReport } from './harness.ts';
import { formatReport } from './report.ts';

const field = (correct: number): FieldReport => ({
  items: 4,
  correct,
  accuracy: correct / 4,
  precision: correct === 0 ? null : 1,
  recall: 0.5,
  falsePositives: 0,
});

const system = (id: string, overrides: Partial<SystemReport> = {}): SystemReport => ({
  id,
  description: `${id} description`,
  fields: Object.fromEntries(TAG_FIELDS.map((name) => [name, field(4)])) as Record<
    TagField,
    FieldReport
  >,
  overallAccuracy: 1,
  minFieldAccuracy: 1,
  costMicrosTotal: 0,
  costMicrosPerItem: 0,
  errors: [],
  mismatches: [],
  ...overrides,
});

const report = (systems: SystemReport[]): EvalReport => ({
  corpus: { name: 'listora-synthetic-tags', generatorVersion: 1, seed: 7, items: 4 },
  systems,
});

describe('formatReport', () => {
  it('prints per-field accuracy, cost per item in dollars, and errors per system', () => {
    const text = formatReport(
      report([
        system('parsers'),
        system('provider:stub', {
          fields: { ...system('x').fields, gtin: field(0) },
          costMicrosPerItem: 1500,
          costMicrosTotal: 6000,
          errors: [{ caseId: 'case-2', message: 'upstream 503' }],
        }),
      ]),
    );
    expect(text).toContain('Tag eval: 4 items from listora-synthetic-tags (generator v1, seed 7)');
    expect(text).toMatch(/^rn\s+100\.0% \(4\/4\)\s+100\.0%\s+50\.0%/m);
    expect(text).toMatch(/^gtin .*0\.0% \(0\/4\)\s+n\/a\s+50\.0%$/m);
    expect(text).toMatch(/^cost\/item\s+\$0\.000000\s+\$0\.001500$/m);
    expect(text).toMatch(/^cost total\s+\$0\.000000\s+\$0\.006000$/m);
    expect(text).toContain('provider:stub failed on case-2: upstream 503');
  });

  it('lists mismatches only when asked', () => {
    const withMismatch = report([
      system('parsers', {
        mismatches: [{ caseId: 'case-1', field: 'rn', expected: ['12345'], actual: [] }],
      }),
    ]);
    expect(formatReport(withMismatch)).not.toContain('mismatches');
    expect(formatReport(withMismatch, { mismatches: true })).toContain(
      'case-1 rn: expected [12345] got []',
    );
  });
});
