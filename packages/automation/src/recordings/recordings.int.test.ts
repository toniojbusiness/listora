/**
 * Every marketplace script against the recorded real pages (docs/features/recorded-pages.md):
 * each plan entry's recording is replayed in a real headless Chromium, and the script must act
 * exactly as it did on the marketplace and get what it got there. A page module that no longer
 * reads a real page, or a script that acts differently from the recording, fails here; re-record
 * with `npm run recordings:record -- <marketplace>` when the script changed on purpose.
 */
import type { Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ListingsPage } from '@listora/marketplaces';

import { createMercariScripts } from '../mercari/scripts.ts';
import { MERCARI_SITE_URL } from '../mercari/site.ts';
import { loadChromium } from '../runner/playwright.ts';
import { recordingPlan } from './plans.ts';
import { expandRecording, loadRecordings, RECORDED_MARKETPLACES } from './recording.ts';
import { replayRecording } from './replay.ts';
import { recordedResult } from './result.ts';

let browser: Browser;

beforeAll(async () => {
  browser = await (await loadChromium()).launch();
});

afterAll(async () => {
  await browser.close();
});

for (const marketplace of RECORDED_MARKETPLACES) {
  const plan = recordingPlan(marketplace);
  const recordings = await loadRecordings(marketplace);

  describe(`${marketplace} scripts on recorded real pages`, () => {
    it('has a recording of every entry of its plan', () => {
      // An entry about one of the seller's listings needs one for sale: without, the recorder
      // skips it (the listings recording shows there was none).
      const earlier = new Map(
        [...recordings].map(([name, recorded]) => [
          name,
          recorded.result.ok ? recorded.result.value : null,
        ]),
      );
      const expected = plan.entries
        .filter(
          (entry) =>
            entry.input === undefined ||
            entry.input(earlier) !== undefined ||
            recordings.has(entry.name),
        )
        .map((entry) => entry.name);
      expect([...recordings.keys()].sort()).toEqual(expected.sort());
      expect(recordings.has('listings')).toBe(true);
    });

    for (const [name, recorded] of recordings) {
      it(`${name}: acts as it did on the real page, and gets what it got there`, async () => {
        const entry = plan.entries.find((candidate) => candidate.name === name);
        if (entry === undefined) throw new Error(`${name} is not in the ${marketplace} plan`);
        // What the script got on the real page: a recording of a failure is a page module to fix.
        expect(recorded.result).toMatchObject({ ok: true });
        const replayed = await replayRecording(
          browser,
          expandRecording(recorded),
          { profile: plan.profile, stepTimeoutMs: plan.stepTimeoutMs, read: entry.mode === 'read' },
          entry.script(recorded.input),
        );
        expect(replayed.divergences).toEqual([]);
        expect(recordedResult(replayed.result)).toEqual(recorded.result);
      }, 60_000);
    }
  });
}

describe('an import that already holds listings, on recorded real pages', () => {
  it("Mercari: reads the active tab and none of the held listings' pages", async () => {
    const plan = recordingPlan('mercari');
    const recorded = (await loadRecordings('mercari')).get('listings');
    if (recorded === undefined) throw new Error('mercari has a listings recording');
    const shown = (recorded.result.ok ? recorded.result.value : null) as ListingsPage | null;
    const ids = shown?.listings.map((listing) => listing.externalListingId) ?? [];
    expect(ids.length).toBeGreaterThan(1);
    const scripts = createMercariScripts({
      site: { origin: MERCARI_SITE_URL },
      photos: { fetch: () => Promise.reject(new Error('a recording sends no photos')) },
    });
    const replayed = await replayRecording(
      browser,
      expandRecording(recorded),
      { profile: plan.profile, stepTimeoutMs: plan.stepTimeoutMs, read: true },
      (step) => scripts.listings?.(null, step, new Set(ids)) ?? Promise.reject(new Error('none')),
    );
    // The tab as recorded, then nothing: each listing's page the full read went on to is left.
    expect(replayed.divergences).toEqual([
      expect.stringMatching(
        new RegExp(
          `^the script finished before .*\\(${String(ids.length)} recorded actions left\\)$`,
        ),
      ) as string,
    ]);
    expect(replayed.result.ok).toBe(true);
    const page = replayed.result.ok ? replayed.result.value : null;
    expect(page?.listings.map((listing) => listing.externalListingId)).toEqual(ids);
    expect(page?.listings.every((listing) => listing.fromList === true)).toBe(true);
  }, 60_000);
});
