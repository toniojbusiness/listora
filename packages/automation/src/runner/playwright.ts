/**
 * Loading Playwright. Its headless Chromium is installed per checkout in `.local/playwright`
 * (`scripts/dev-browser.sh`), like the Postgres cluster in `.local/pg`; the runner image sets
 * `PLAYWRIGHT_BROWSERS_PATH` to its own copy. Playwright reads that variable once, when it is
 * first imported, so this module is the only one that imports it at run time: it fixes the
 * path first. Nothing else may import `playwright-core` except for types.
 */
import { fileURLToPath } from 'node:url';

import type { BrowserType } from 'playwright-core';

/** `.local/playwright` at the repository root (gitignored). */
export const DEFAULT_BROWSERS_PATH = fileURLToPath(
  new URL('../../../../.local/playwright', import.meta.url),
);

let loaded: Promise<BrowserType> | undefined;

/** Playwright's Chromium, with its browsers under `PLAYWRIGHT_BROWSERS_PATH` or the default. */
export function loadChromium(): Promise<BrowserType> {
  loaded ??= (async () => {
    process.env['PLAYWRIGHT_BROWSERS_PATH'] ??= DEFAULT_BROWSERS_PATH;
    const playwright = await import('playwright-core');
    return playwright.chromium;
  })();
  return loaded;
}
