/**
 * What an adapter's read throws to say why it got no answer: `code` names the reason, and
 * `retryAfterMs` says when the read may run at the soonest when Listora itself held it back
 * before it reached the marketplace (the seller's share of automated runs for now,
 * `automation_paced`, or another run on the same session, `automation_busy`), `null` otherwise.
 * A read held back learned nothing about the listing and failed nothing on the marketplace, so
 * the engine waits that long and reads again rather than counting it as a failed read.
 */
export class ListingReadError extends Error {
  readonly code: string;
  readonly retryAfterMs: number | null;

  constructor(code: string, message: string, retryAfterMs: number | null = null) {
    super(message);
    this.name = 'ListingReadError';
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}
