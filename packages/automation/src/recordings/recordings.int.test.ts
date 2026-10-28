/**
 * Every marketplace script against the recorded real pages (docs/features/recorded-pages.md):
 * each plan entry's recording is replayed in a real headless Chromium, and the script must act
 * exactly as it did on the marketplace and get what it got there. A page module that no longer
 * reads a real page, or a script that acts differently from the recording, fails here; re-record
 * with `npm run recordings:record -- <marketplace>` when the script changed on purpose.
 */
import type { Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
