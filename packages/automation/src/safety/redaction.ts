/**
 * Keeping cookies and personal data out of logs, history, and screenshots. Marketplace pages
 * are full of personal data (the seller's name and address, buyers' names, messages), so:
 *
 * - logs and history name the script, the step, and the page's origin, never a full URL (paths
 *   carry usernames) and never page text;
 * - error messages keep only their first line, without anything the run typed or uploaded;
 * - screenshots black out every form field and the profile's private elements, and show only
 *   the viewport;
 * - cookies never leave the vault and the browser: log lines that name them are redacted by
 *   the shared logger (`cookie`, `cookies`).
 */

/** Every form field, whatever it holds. */
export const SCREENSHOT_MASK_SELECTORS = [
  'input',
  'textarea',
  'select',
  '[contenteditable]:not([contenteditable="false"])',
] as const;

const MAX_ERROR_LENGTH = 200;

/** The origin of a URL, the only part of it that logs and history keep. */
export function originForLog(url: string): string {
  return URL.canParse(url) ? new URL(url).origin : 'unknown';
}

/**
 * The first line of an error message, cut short, with every value the run typed or uploaded
 * replaced, and URLs reduced to their origin.
 */
export function sanitizeMessage(message: string, typed: Iterable<string>): string {
  let line = message.split('\n', 1)[0] ?? '';
  for (const value of typed) {
    if (value.length >= 3) line = line.split(value).join('[redacted]');
  }
  line = line.replace(/\bhttps?:\/\/[^\s'")]+/g, (url) => originForLog(url));
  return line.length > MAX_ERROR_LENGTH ? `${line.slice(0, MAX_ERROR_LENGTH)}...` : line;
}

/** A thrown value as a log line may carry it: its name and its sanitized first line. */
export function sanitizedError(
  thrown: unknown,
  typed: Iterable<string> = [],
): { name: string; message: string } {
  const name = thrown instanceof Error ? thrown.name : 'Error';
  return {
    name,
    message: sanitizeMessage(thrown instanceof Error ? thrown.message : String(thrown), typed),
  };
}
