/**
 * Errors a script throws on purpose. Every other error a script throws is a `script_error`,
 * which the adapter base retries; these say something more specific about the page.
 */

/**
 * The page is not the one the script expects, or lacks what it reads (the marketplace changed
 * it). The run reports `element_missing`, like a wait for an element that never came, so a
 * step that has not mutated falls back to the user's task instead of retrying a script that
 * no longer fits the site. The message names the page and what is missing, never page text or
 * anything the run typed.
 */
export class PageChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageChangedError';
  }
}
