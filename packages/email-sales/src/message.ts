/**
 * Reading a raw RFC 5322 message (MIME decoding by postal-mime) into the little the parsers
 * need: who sent it, its subject and date, its text, and the links it holds. Nothing here keeps
 * the message; the raw mail is deleted once it is processed.
 */
import PostalMime, { type Header } from 'postal-mime';

/** Sale and confirmation emails are tens of kilobytes; anything far larger is not one. */
export const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

export interface MailMessage {
  /** The Message-ID without angle brackets, or null when the message has none. */
  messageId: string | null;
  /** The From address, lower case, and its domain; null when it has none Listora can read. */
  from: { address: string; domain: string } | null;
  subject: string;
  /** The Date header, or null when it is missing or unreadable. */
  date: Date | null;
  /** The plain text, or the HTML part as text when there is no plain part. */
  text: string;
  /** Every http(s) link in the HTML (`href`) and the text, in order, without duplicates. */
  links: string[];
  /** All headers in message order, keys lower case (the receiving server's are first). */
  headers: readonly Header[];
}

export class UnreadableMessageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UnreadableMessageError';
  }
}

export async function readMessage(raw: Uint8Array): Promise<MailMessage> {
  if (raw.byteLength > MAX_MESSAGE_BYTES) {
    throw new UnreadableMessageError('the message is larger than a sale email can be');
  }
  let email;
  try {
    email = await PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer', maxPartCount: 50 });
  } catch (error) {
    throw new UnreadableMessageError('the message is not valid MIME', { cause: error });
  }
  const fromAddress = email.from?.address?.trim().toLowerCase();
  const domain = fromAddress?.split('@')[1];
  const html = email.html ?? '';
  const text = email.text !== undefined && email.text.trim() !== '' ? email.text : htmlToText(html);
  const date = email.date === undefined ? null : new Date(email.date);
  return {
    messageId: messageIdOf(email.messageId),
    from:
      fromAddress !== undefined && domain !== undefined && domain !== ''
        ? { address: fromAddress, domain }
        : null,
    subject: (email.subject ?? '').trim(),
    date: date !== null && !Number.isNaN(date.getTime()) ? date : null,
    text: normalizeText(text),
    links: links(html, text),
    headers: email.headers,
  };
}

/** The Message-ID without angle brackets; null when it is missing or empty. */
function messageIdOf(value: string | undefined): string | null {
  const id = value?.trim().replace(/^<|>$/g, '') ?? '';
  return id === '' ? null : id;
}

/** The values of a header, in message order (the receiving server's own come first). */
export function headerValues(message: Pick<MailMessage, 'headers'>, name: string): string[] {
  const key = name.toLowerCase();
  return message.headers.filter((header) => header.key === key).map((header) => header.value);
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

/** The HTML's text: blocks become lines, tags go, entities are decoded. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6]|table|td)>/gi, '\n')
      .replace(/<[^>]*>/g, ' '),
  );
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\t \u00a0]+/g, ' ').trim())
    .filter((line, index, lines) => line !== '' || (index > 0 && lines[index - 1] !== ''))
    .join('\n')
    .trim();
}

function links(html: string, text: string): string[] {
  const found: string[] = [];
  for (const match of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    if (match[1] !== undefined) found.push(decodeEntities(match[1]));
  }
  for (const match of text.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) found.push(match[0]);
  return [
    ...new Set(found.map((link) => link.trim()).filter((link) => /^https?:\/\//i.test(link))),
  ];
}
