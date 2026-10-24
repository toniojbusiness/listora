/**
 * Seeded pseudo-random generator (mulberry32). The corpus must be byte-for-byte reproducible
 * from its seed, so generation never uses `Math.random`.
 */
export interface Random {
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [min, max], inclusive. */
  int(min: number, max: number): number;
  /** True with probability `p`. */
  chance(p: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** `count` distinct items in random order. */
  sample<T>(items: readonly T[], count: number): T[];
  /** A string of `length` random decimal digits. */
  digits(length: number): string;
}

export function createRandom(seed: number): Random {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => {
    if (items.length === 0) throw new RangeError('pick from an empty list');
    return items[int(0, items.length - 1)] as T;
  };
  return {
    next,
    int,
    chance: (p) => next() < p,
    pick,
    sample: <T>(items: readonly T[], count: number): T[] => {
      const pool = [...items];
      const chosen: T[] = [];
      while (chosen.length < count && pool.length > 0) {
        chosen.push(pool.splice(int(0, pool.length - 1), 1)[0] as T);
      }
      return chosen;
    },
    digits: (length) => Array.from({ length }, () => String(int(0, 9))).join(''),
  };
}
