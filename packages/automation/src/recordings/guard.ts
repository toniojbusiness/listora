/**
 * A recording session's tab never sends a file (record.ts): a request that carries one (a
 * multipart body, an image body: a photo upload) is aborted before it leaves the browser,
 * whatever the page or the script does. A recording adds no photo to anything.
 *
 * The page's own other traffic goes through as it does for the seller browsing by hand. The
 * recorder changes nothing because of what it runs (reads as reads; forms filled without a
 * photo and never sent, every step that would send or change something refused), not because
 * of the network: blocking a page's own background requests broke the pages (Depop's and
 * Mercari's sell forms read through POSTs) and made them retry hundreds of times, which brought
 * on the marketplaces' checks (2026-10-27).
 */
import type { Page, Request } from 'playwright-core';

/** Guards the tab; the map counts what was blocked, by method and origin. */
export async function guardTab(page: Page): Promise<Map<string, number>> {
  const blocked = new Map<string, number>();
  await page.route('**/*', async (route) => {
    const request = route.request();
    if (!carriesFile(request)) {
      await route.fallback();
      return;
    }
    const origin = URL.canParse(request.url()) ? new URL(request.url()).origin : 'unknown';
    const key = `${request.method()} ${origin}`;
    blocked.set(key, (blocked.get(key) ?? 0) + 1);
    await route.abort('blockedbyclient');
  });
  return blocked;
}

/** Whether a request sends a file: a multipart body, or a body that is an image or a file. */
export function carriesFile(request: Pick<Request, 'method' | 'headers'>): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return false;
  const type = (request.headers()['content-type'] ?? '').toLowerCase();
  return (
    type.startsWith('multipart/') ||
    type.startsWith('image/') ||
    type.startsWith('video/') ||
    type === 'application/octet-stream'
  );
}
