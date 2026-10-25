/**
 * Depop listing text, shared by the item analysis that writes it and the Depop adapter that
 * sends and reads it back. Depop listings have no title: the description field is the whole
 * listing text, and its hashtags are part of it (Selling API `description`: "Limited to 1000
 * characters", "Email addresses are not allowed", "Can only have up to 5 hashtags";
 * https://partnerapi.depop.com/api-docs/openapi.yaml).
 */

/** Text that looks like an email address, which Depop refuses in descriptions. */
export const DEPOP_EMAIL_ADDRESS = /[^\s@]+@[^\s@]+\.[^\s@]+/;

/** What Depop's description field gets: the copy, then its hashtags on their own line. */
export function depopDescription(description: string, hashtags: readonly string[]): string {
  return hashtags.length === 0
    ? description
    : `${description}\n\n${hashtags.map((tag) => `#${tag}`).join(' ')}`;
}

/** A last paragraph of nothing but hashtags: `#vintage #denim`. */
const HASHTAG_LINE = /^#[^\s#]+(?: #[^\s#]+)*$/;

/**
 * The copy and hashtags of a Depop description, the inverse of `depopDescription`: a last
 * paragraph made only of hashtags is the hashtags, and everything before it the copy.
 */
export function splitDepopDescription(text: string): { description: string; hashtags: string[] } {
  const breakAt = text.lastIndexOf('\n\n');
  const last = breakAt === -1 ? '' : text.slice(breakAt + 2);
  if (!HASHTAG_LINE.test(last)) return { description: text, hashtags: [] };
  return {
    description: text.slice(0, breakAt),
    hashtags: last.split(' ').map((tag) => tag.slice(1)),
  };
}

/** Whether copy ends with its own hashtag paragraph, which would read back as hashtags. */
export function endsWithHashtagLine(description: string): boolean {
  return splitDepopDescription(description).hashtags.length > 0;
}
