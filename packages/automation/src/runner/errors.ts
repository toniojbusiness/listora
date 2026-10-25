/**
 * What a script throws when a page is not the way it expects: a field missing from the page's
 * data, a status it does not know, a form without the button it submits with. The run ends as
 * `element_missing` (the site may have changed), so a step that changed nothing goes to the
 * user instead of being retried against a page that will not change back. The message is
 * logged and stored, so it says what the script expected and never repeats page content.
 */
export class PageChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageChangedError';
  }
}
