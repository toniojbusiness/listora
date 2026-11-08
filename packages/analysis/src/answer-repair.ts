/**
 * Deterministic repairs of an analysis answer, applied before it is validated. The schema
 * travels in the prompt, not as a grammar (`output-schema.ts`), so a model sometimes writes a
 * vocabulary word in its own spelling ("Olive", "Animal Print"), a full category path in the
 * category field, or a hashtag with its "#". Live answers failed this way on Haiku and Sonnet
 * alike (2026-11-05 to 11-07: a color, the category, and a Depop hashtag), and a second answer
 * often failed the same way, so the analysis failed for a spelling.
 *
 * Each repair maps a value to the one vocabulary id it plainly means, or, when it means none,
 * to "not found" (an empty value), which the system prompt already prefers to a guess. A value
 * that is out of range in any other way, a contradiction between fields, or copy over its
 * limit is not repaired: the schema still refuses it, and the call is tried again.
 */
import { HASHTAG, MARKETPLACE_COPY_LIMITS } from './marketplace-copy.ts';
import {
  CATEGORIES,
  CATEGORY_TREE,
  type Category,
  type Color,
  type Department,
} from './vocabulary.ts';

/**
 * A vocabulary word as an id: trimmed, lowercase, spaces and dashes as underscores, and no
 * spaces around a category path's slashes ("Clothing / Tops" is "clothing/tops").
 */
export function asVocabularyId(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value
    .trim()
    .toLowerCase()
    .replace(/\s*\/\s*/g, '/')
    .replace(/[\s-]+/g, '_');
}

/**
 * One of `values` for a word the model wrote, `""` (not found) for a word it is not, and any
 * other value unchanged for the schema to refuse. `aliases` maps other words to an id.
 */
export function vocabularyWord(
  values: readonly string[],
  aliases: Readonly<Record<string, string>> = {},
): (value: unknown) => unknown {
  return (value) => {
    const id = asVocabularyId(value);
    if (typeof id !== 'string') return value;
    if (id === '' || values.includes(id)) return id;
    const alias = aliases[id];
    if (alias !== undefined) return alias;
    // "dark_green", "light_blue": the last word names the color.
    const last = id.split('_').at(-1) ?? '';
    if (values.includes(last)) return last;
    const lastAlias = aliases[last];
    return lastAlias ?? '';
  };
}

/**
 * A list of vocabulary words: each one as `vocabularyWord` reads it, those that are no word of
 * the list left out, and each kept once.
 */
export function vocabularyList(
  values: readonly string[],
  aliases: Readonly<Record<string, string>> = {},
): (value: unknown) => unknown {
  const word = vocabularyWord(values, aliases);
  return (value) => {
    if (!Array.isArray(value)) return value;
    const words: unknown[] = (value as unknown[]).map(word);
    const kept = words.filter((entry): entry is string => typeof entry === 'string');
    if (kept.length !== words.length) return value as unknown;
    return [...new Set(kept.filter((entry) => entry !== ''))];
  };
}

/** Color names a model writes for the colors of `COLORS`. */
export const COLOR_ALIASES: Readonly<Record<string, Color>> = {
  grey: 'gray',
  charcoal: 'gray',
  heather: 'gray',
  ivory: 'cream',
  off_white: 'cream',
  offwhite: 'cream',
  ecru: 'cream',
  khaki: 'tan',
  camel: 'tan',
  taupe: 'beige',
  nude: 'beige',
  burgundy: 'red',
  maroon: 'red',
  wine: 'red',
  olive: 'green',
  sage: 'green',
  mint: 'green',
  teal: 'blue',
  turquoise: 'blue',
  denim: 'blue',
  lavender: 'purple',
  lilac: 'purple',
  plum: 'purple',
  rose: 'pink',
  blush: 'pink',
  coral: 'orange',
  rust: 'orange',
  mustard: 'yellow',
  multi: 'multicolor',
  multi_color: 'multicolor',
  multicolored: 'multicolor',
  multicolour: 'multicolor',
};

/** Words a model writes for the departments of `DEPARTMENTS`. */
export const DEPARTMENT_ALIASES: Readonly<Record<string, Department>> = {
  womens: 'women',
  "women's": 'women',
  woman: 'women',
  female: 'women',
  ladies: 'women',
  mens: 'men',
  "men's": 'men',
  man: 'men',
  male: 'men',
  kid: 'kids',
  "kids'": 'kids',
  children: 'kids',
  girls: 'kids',
  boys: 'kids',
  baby: 'kids',
};

/** The categories a subcategory id belongs to. */
function categoriesOf(subcategory: string): Category[] {
  return CATEGORIES.filter((category) =>
    (CATEGORY_TREE[category] as readonly string[]).includes(subcategory),
  );
}

/** The one category `subcategory` belongs to, or null when it is in none or several. */
function onlyCategoryOf(subcategory: string): Category | null {
  const owners = categoriesOf(subcategory);
  return owners.length === 1 ? (owners[0] ?? null) : null;
}

function isCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value);
}

/**
 * The category and subcategory of an answer's attributes, read as the ids they plainly mean:
 * - a full path in the category field, "clothing/tops/t_shirts", is the category and, when the
 *   subcategory is empty, the subcategory;
 * - a clothing category without its "clothing/" ("tops") is that category;
 * - a subcategory written as the category, or a subcategory without its category, gives the
 *   one category it belongs to (`sneakers` is in `shoes`);
 * - a category that is none of these is not found, and so is a subcategory left without one.
 *
 * A subcategory of another category than the one chosen stays as written, for the schema to
 * refuse: the answer contradicts itself.
 */
export function repairCategory(attributes: unknown): unknown {
  if (typeof attributes !== 'object' || attributes === null || Array.isArray(attributes)) {
    return attributes;
  }
  const record = attributes as Record<string, unknown>;
  const writtenCategory = asVocabularyId(record['category']);
  const writtenSubcategory = asVocabularyId(record['subcategory']);
  if (typeof writtenCategory !== 'string' || typeof writtenSubcategory !== 'string') {
    return attributes;
  }
  let category: string = writtenCategory;
  let subcategory: string = writtenSubcategory;

  if (category !== '' && !isCategory(category)) {
    const written = category;
    const parent = CATEGORIES.find((candidate) => written.startsWith(`${candidate}/`));
    if (parent !== undefined) {
      const rest = written.slice(parent.length + 1);
      category = parent;
      if (subcategory === '' && categoriesOf(rest).includes(parent)) subcategory = rest;
    } else if (isCategory(`clothing/${written}`)) {
      category = `clothing/${written}`;
    } else {
      const owner = onlyCategoryOf(written);
      category = owner ?? '';
      if (owner !== null && subcategory === '') subcategory = written;
    }
  }
  if (category === '' && subcategory !== '') {
    category = onlyCategoryOf(subcategory) ?? '';
    if (category === '') subcategory = '';
  }
  return { ...record, category, subcategory };
}

/**
 * Depop hashtags as the copy rules want them: without the "#", lowercase letters and digits
 * only, at most 30 characters each, each once, and no more than Depop's five.
 */
export function repairHashtags(hashtags: unknown): unknown {
  if (!Array.isArray(hashtags) || hashtags.some((tag) => typeof tag !== 'string')) {
    return hashtags;
  }
  const tags = (hashtags as string[])
    .map((tag) =>
      tag
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .slice(0, 30),
    )
    .filter((tag) => HASHTAG.test(tag));
  return [...new Set(tags)].slice(0, MARKETPLACE_COPY_LIMITS.depop.hashtags);
}
