/**
 * What a script throws when a page is not the way it expects: a field missing from the page's
 * data, a status it does not know, a form without the button it submits with. The run ends as
 * `element_missing` (the page is not as the script expects), so a step that changed nothing goes to the
 * user instead of being retried against a page that will not change back. The message is
 * logged and stored, so it says what the script expected and never repeats page content.
 */
export class PageChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageChangedError';
  }
}

/**
 * What a script throws when the marketplace's own page says it failed and to try again (Mercari's
 * "Your item could not be listed due to an error"): not a refusal of the listing, and not a page
 * Listora no longer understands. The run ends as `server_error`, which is retried once the
 * listing is read back. The message is logged and stored, so it never repeats page content.
 */
export class MarketplaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarketplaceError';
  }
}
