/**
 * Listing descriptions. Listora's copy is plain text; eBay's `Item.Description` is HTML. The
 * adapter sends the text escaped, with line breaks as `<br>`, and reads eBay's HTML back to
 * text the inverse way, so a read-back can compare it with the text Listora sent: for any
 * text, `descriptionText(descriptionHtml(text)) === text`.
 */
import { escapeXml } from './xml.ts';

export function descriptionHtml(text: string): string {
  return escapeXml(text).replaceAll('\n', '<br>');
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

/** The text of an eBay description: `<br>` as a line break, other tags dropped. */
export function descriptionText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity: string, name: string) => {
      if (/^#x/i.test(name)) return codePoint(Number.parseInt(name.slice(2), 16)) ?? entity;
      if (name.startsWith('#')) return codePoint(Number.parseInt(name.slice(1), 10)) ?? entity;
      return ENTITIES[name.toLowerCase()] ?? entity;
    });
}

function codePoint(code: number): string | undefined {
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
    ? String.fromCodePoint(code)
    : undefined;
}
