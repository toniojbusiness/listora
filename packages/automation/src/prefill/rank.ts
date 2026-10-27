/**
 * The free, deterministic half of the pre-fill's ranking: how well a marketplace's own category
 * or size names match what the item analysis said about the item. It orders the short lists the
 * review offers and the candidates the AI picks from, and refines a mapped category into the one
 * of its subcategories the item's own words name (`Women > Jeans` into `Skinny Jeans` for
 * "skinny jeans"). Nothing here calls anything.
 */

/** What the item's words are, weighted by how much each says about what the item is. */
export interface ItemWords {
  /** Each word's weight: the title's count most, then the product name and keywords. */
  readonly weights: ReadonlyMap<string, number>;
  /** The words of the title, product name, and keywords: what the item is called. */
  readonly naming: ReadonlySet<string>;
}

/** The words of an item, from its analyzed details. */
export interface ItemText {
  readonly title: string | null;
  readonly productName: string | null;
  readonly keywords: readonly string[];
  /** The canonical category, for example `clothing/bottoms/jeans`. */
  readonly category: string | null;
  readonly description: string | null;
}

/** Words that name no kind of item, in every marketplace's names and in item text. */
const STOP_WORDS = new Set([
  'and',
  'the',
  'for',
  'with',
  'all',
  'other',
  'others',
  'size',
  // Too common in category names ("Pajama Sets", "Matching Sets") to say what a thing is.
  'set',
  'new',
  'used',
  'item',
  'items',
  'accessories',
  'women',
  'woman',
  'womens',
  'men',
  'man',
  'mens',
  'kids',
  'kid',
  'clothing',
  'vintage',
]);

/** Lower-case words of `text`, singular, without stop words. */
export function words(text: string | null | undefined): string[] {
  if (text === null || text === undefined) return [];
  return text
    .toLowerCase()
    .replaceAll(/['’]s\b/g, '')
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 2 && !STOP_WORDS.has(word))
    .map(singular);
}

function singular(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(ch|sh|ss|x)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** The item's words, weighted: title 3, product name and keywords 2, category 2, text 1. */
export function itemWords(text: ItemText): ItemWords {
  const weights = new Map<string, number>();
  const naming = new Set<string>();
  const add = (list: readonly string[], weight: number, names: boolean) => {
    for (const word of new Set(list)) {
      weights.set(word, (weights.get(word) ?? 0) + weight);
      if (names) naming.add(word);
    }
  };
  add(words(text.title), 3, true);
  add(words(text.productName), 2, true);
  add(
    text.keywords.flatMap((keyword) => words(keyword)),
    2,
    true,
  );
  add(words(text.category?.replaceAll(/[/_]/g, ' ')), 2, false);
  add(words(text.description), 1, false);
  return { weights, naming };
}

/**
 * How well a path of names matches the item: each of its words the item has counts that word's
 * weight, the last name's twice (it is what the item is; the others say where it is filed).
 */
export function pathScore(path: readonly string[], item: ItemWords): number {
  let score = 0;
  path.forEach((name, index) => {
    const factor = index === path.length - 1 ? 2 : 1;
    for (const word of new Set(words(name))) score += (item.weights.get(word) ?? 0) * factor;
  });
  return score;
}

/** One candidate: what a listing names it by, and its names, top level first. */
export interface Candidate {
  readonly value: string;
  readonly path: readonly string[];
}

/** `candidates` best match first (ties in their own order), only those that match at all. */
export function rankCandidates<C extends Candidate>(
  candidates: readonly C[],
  item: ItemWords,
  limit: number,
): C[] {
  return candidates
    .map((candidate, index) => ({ candidate, index, score: pathScore(candidate.path, item) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.candidate);
}

/**
 * The one of `children` the item's own name says it is: every word of the child's name that its
 * parent's name doesn't have is in the item's title, product name, or keywords (`Skinny Jeans`
 * under Jeans for "Levi's skinny jeans"), and only one child is named that way. A child whose
 * name says no more than its parent's (`Short shorts` under Shorts), or that has a word the item
 * never says (`V-neck` for a ruffle neck), is never chosen. A name with alternatives is named by
 * any one of them (`Above knee, mini` for a "mini dress"). `null` otherwise, so a refinement is
 * never a guess.
 */
export function namedChild<C extends Candidate>(children: readonly C[], item: ItemWords): C | null {
  // A name can give alternatives, separated by commas (Mercari's `Above knee, mini`,
  // `Straight, pencil`): each is the child's name on its own.
  const alternatives = (child: C): string[][] => {
    const parent = new Set(words(child.path.at(-2)));
    // Every word, one letter long too (the `V` of `V-neck`), less the parent's.
    return (child.path.at(-1) ?? '').split(',').map((part) =>
      part
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word !== '' && !STOP_WORDS.has(word))
        .map(singular)
        .filter((word) => !parent.has(word)),
    );
  };
  /** How many words of the child's name the item says: its longest alternative it says whole. */
  const said = (child: C): number =>
    Math.max(
      0,
      ...alternatives(child)
        .filter((leaf) => leaf.length > 0 && leaf.every((word) => item.naming.has(word)))
        .map((leaf) => leaf.length),
    );
  const named = children.filter((child) => said(child) > 0);
  if (named.length === 0) return null;
  // The most specific name wins ("Skinny Jeans" over "Jeans"); two equally specific ones tie.
  const most = Math.max(...named.map(said));
  const best = named.filter((child) => said(child) === most);
  return best.length === 1 ? (best[0] ?? null) : null;
}

/**
 * The part of each path that tells it apart from the others: the names they all start or end
 * with are left out (`Men` and `Women` for `Men > Tops > T-shirts` and `Women > Tops >
 * T-shirts`). A path left with nothing, or the only path, keeps all of its names.
 */
export function distinguishingLabels(paths: readonly (readonly string[])[]): string[] {
  if (paths.length < 2) return paths.map((path) => path.join(' > '));
  const shortest = Math.min(...paths.map((path) => path.length));
  let head = 0;
  while (head < shortest - 1 && paths.every((path) => path[head] === paths[0]?.[head])) head += 1;
  let tail = 0;
  while (
    tail < shortest - head - 1 &&
    paths.every((path) => path.at(-1 - tail) === paths[0]?.at(-1 - tail))
  ) {
    tail += 1;
  }
  return paths.map((path) => {
    const middle = path.slice(head, path.length - tail);
    return (middle.length === 0 ? path : middle).join(' > ');
  });
}

/**
 * A size list's labels ordered by how close each is to the tag's size: the labels that contain
 * the tag's size as a word (`M (8-10)` for `M`), then those with the nearest number, then the
 * rest in the list's own order.
 */
export function rankSizes(tagSize: string | null, labels: readonly string[]): string[] {
  const tag = (tagSize ?? '').trim().toLowerCase();
  if (tag === '') return [...labels];
  const tagTokens = tag.split(/[^a-z0-9.]+/).filter((token) => token !== '');
  const tagNumber = firstNumber(tag);
  const scored = labels.map((label, index) => {
    const lower = label.toLowerCase();
    const tokens = lower.split(/[^a-z0-9.]+/).filter((token) => token !== '');
    let score = 0;
    if (lower === tag) score += 100;
    score += tagTokens.filter((token) => tokens.includes(token)).length * 10;
    const number = firstNumber(lower);
    if (tagNumber !== null && number !== null) {
      score += Math.max(0, 5 - Math.abs(number - tagNumber));
    }
    return { label, index, score };
  });
  return scored.sort((a, b) => b.score - a.score || a.index - b.index).map((entry) => entry.label);
}

function firstNumber(text: string): number | null {
  const match = /\d+(?:\.\d+)?/.exec(text);
  return match === null ? null : Number(match[0]);
}
