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

/**
 * What a script throws when a page that only a signed-in seller sees is drawn for a visitor
 * instead: the marketplace's signed-out header where its member's own is (Vinted's "Sign up | Log
 * in" button). The marketplace signed the seller out without sending them to its sign-in page,
 * so no inspection sees a login page; the run ends as one does (`session_rejected`), and the
 * seller is asked to link the account again. The message is logged and stored, so it never
 * repeats page content.
 */
export class SignedOutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignedOutError';
  }
}
