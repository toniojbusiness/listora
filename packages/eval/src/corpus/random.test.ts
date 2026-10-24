import { describe, expect, it } from 'vitest';

import { createRandom } from './random.ts';

describe('createRandom', () => {
  it('repeats the same sequence for the same seed', () => {
    const a = createRandom(42);
    const b = createRandom(42);
    expect(Array.from({ length: 5 }, () => a.next())).toEqual(
      Array.from({ length: 5 }, () => b.next()),
    );
    expect(createRandom(43).next()).not.toBe(createRandom(42).next());
  });

  it('stays within the requested ranges', () => {
    const random = createRandom(7);
    for (let i = 0; i < 1000; i += 1) {
      const value = random.int(3, 5);
      expect(value).toBeGreaterThanOrEqual(3);
      expect(value).toBeLessThanOrEqual(5);
      const float = random.next();
      expect(float).toBeGreaterThanOrEqual(0);
      expect(float).toBeLessThan(1);
    }
    expect(random.digits(8)).toMatch(/^[0-9]{8}$/);
  });

  it('samples distinct items and refuses to pick from nothing', () => {
    const random = createRandom(9);
    const sample = random.sample(['a', 'b', 'c', 'd'], 3);
    expect(new Set(sample).size).toBe(3);
    expect(random.sample(['a'], 3)).toEqual(['a']);
    expect(() => random.pick([])).toThrow(RangeError);
  });
});
