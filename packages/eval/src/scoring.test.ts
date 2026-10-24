import { describe, expect, it } from 'vitest';

import { TAG_FIELDS, emptyTagValues, type TagField } from '@listora/tag-parse';

import { accuracy, emptyTally, precision, recall, scoreItem, type FieldTally } from './scoring.ts';

const tallies = (): Record<TagField, FieldTally> =>
  Object.fromEntries(TAG_FIELDS.map((field) => [field, emptyTally()])) as Record<
    TagField,
    FieldTally
  >;

describe('scoreItem', () => {
  it('counts an empty prediction for an empty truth as correct', () => {
    const t = tallies();
    expect(scoreItem(t, emptyTagValues(), {})).toEqual([]);
    expect(accuracy(t.rn)).toBe(1);
    expect(precision(t.rn)).toBeNull();
    expect(recall(t.rn)).toBeNull();
  });

  it('requires the exact set of values, ignoring order and duplicates', () => {
    const t = tallies();
    const truth = {
      ...emptyTagValues(),
      fiber: [
        { part: null, material: 'cotton', percent: 60 },
        { part: null, material: 'polyester', percent: 40 },
      ],
    } as const;
    const mismatches = scoreItem(t, truth, {
      fiber: [
        { part: null, material: 'polyester', percent: 40 },
        { part: null, material: 'cotton', percent: 60 },
        { part: null, material: 'cotton', percent: 60 },
      ],
    });
    expect(mismatches).toEqual([]);
    expect(t.fiber).toMatchObject({ correct: 1, truePositives: 2, falsePositives: 0 });
  });

  it('charges false positives and misses, and reports what differed', () => {
    const t = tallies();
    const mismatches = scoreItem(
      t,
      { ...emptyTagValues(), rn: ['12345'] },
      { rn: ['12346'], ca: ['90012'] },
    );
    expect(mismatches).toEqual([
      { field: 'rn', expected: ['12345'], actual: ['12346'] },
      { field: 'ca', expected: [], actual: ['90012'] },
    ]);
    expect(t.rn).toMatchObject({
      correct: 0,
      truePositives: 0,
      falsePositives: 1,
      falseNegatives: 1,
    });
    expect(t.ca).toMatchObject({ correct: 0, falsePositives: 1 });
    expect(precision(t.rn)).toBe(0);
    expect(recall(t.rn)).toBe(0);
  });
});
