/**
 * The short excerpt Listora keeps of a sale email, so the seller can see what it said in a
 * review or confirm task: the start of its text with addresses, links, numbers that could be a
 * phone or an account, user names, and the lines that name a buyer or a shipping address taken
 * out. The rest of the message is never stored.
 */

/** Characters kept of an email's text. */
export const EXCERPT_LENGTH = 280;

/** Lines that introduce a buyer's details: everything after the label is removed. */
const PERSONAL_LINE =
  /^(\s*(buyer|ship(ping)?\s*to|deliver\s*to|address|name|sold\s*to|recipient|phone)\b[^:]*:).*$/gim;

export function redactedExcerpt(text: string): string {
  const redacted = text
    .replace(PERSONAL_LINE, '$1 [removed]')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]')
    .replace(/https?:\/\/\S+/gi, '[link]')
    .replace(/(?<![\w@])@[A-Za-z0-9_.]{2,}/g, '[user]')
    .replace(/\+?\d[\d ().-]{6,}\d/g, (run) =>
      run.replace(/\D/g, '').length >= 7 ? '[number]' : run,
    )
    .replace(/\s+/g, ' ')
    .trim();
  if (redacted.length <= EXCERPT_LENGTH) return redacted;
  const cut = redacted.slice(0, EXCERPT_LENGTH);
  const space = cut.lastIndexOf(' ');
  return `${(space > EXCERPT_LENGTH / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
