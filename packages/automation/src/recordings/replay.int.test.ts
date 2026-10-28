/**
 * Recording and replaying, end to end on a local page with scripts of its own (a combobox its
 * script opens, data in a global whose script removes itself, a read of its web API, a link to
 * another page) in a real headless Chromium: what a script reads on the recording is what it
 * read live, a page that lost what the script needs fails as it would live, a script that acts
 * differently is caught, a check on a recorded page stops the replay, and a recording session's
 * tab sends no photo.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SessionCookie } from '@listora/connections';

import { BridgeBackend } from '../phone/backend.ts';
import { PlaywrightPhoneHost } from '../phone/test-host.ts';
import { automationProfile, standInProfile } from '../profiles.ts';
import { NetworkLog } from '../runner/network-log.ts';
import { loadChromium } from '../runner/playwright.ts';
import { MemoryScreenshotStore } from '../runner/screenshots.ts';
import { ScriptSession } from '../runner/script-session.ts';
import { PlaywrightBackend } from '../runner/session.ts';
import type { PageDriver, Script } from '../runner/types.ts';
import { Pacing } from '../safety/pacing.ts';
import { QUICK_PACING, silentLogger } from '../test-support.ts';
import { guardTab } from './guard.ts';
import {
  compactStates,
  expandRecording,
  parseRecording,
  RECORDING_FORMAT,
  RECORDING_HOSTS,
  type ExpandedRecording,
  type RecordingHost,
} from './recording.ts';
import { RecordingBackend } from './recording-backend.ts';
import { redactRecordings, unredacted } from './redact.ts';
import { replayRecording } from './replay.ts';

const FORM = `<!doctype html><html><head><title>Sell</title>
<script>window.__STATE__ = { seller: { username: 'jdoe_seller', email: 'jdoe@gmail.com' }, items: 3 };
document.currentScript.remove();</script>
<style>.closed { display: none } .ghost { opacity: 0 }</style></head><body>
<form><input id="size-input" readonly value="">
<button type="button" id="size-toggle">Size</button>
<ul id="size-menu" class="closed"><li role="option">S</li><li role="option">M</li></ul>
<input type="password" class="ghost" id="hidden-login">
<a id="next" href="/done/">Next</a><a href="/jdoe_seller/">Your shop</a>
<img src="https://cdn.example.com/u/jdoe_seller/avatar.jpg"></form>
<script>
  const menu = document.getElementById('size-menu');
  document.getElementById('size-toggle').addEventListener('click', () => {
    menu.classList.remove('closed');
    menu.setAttribute('style', '--display: block');
  });
  for (const option of menu.children) option.addEventListener('click', () => {
    document.getElementById('size-input').value = option.textContent;
    menu.classList.add('closed');
    menu.removeAttribute('style');
  });
</script></body></html>`;

const DONE = `<!doctype html><html><head><title>Done</title></head><body><h1 data-testid="done">Listed by jdoe_seller</h1></body></html>`;

/** The script the tests record and replay: what a page module does on a sell form. */
const sellScript =
  (option = 'M'): Script<unknown> =>
  (step) =>
    step('fill the size', { mutates: false }, async (page: PageDriver) => {
      await page.goto(`${origin}/sell/`);
      await page.waitFor('#size-input', 'attached');
      const state = (await page.pageData('__STATE__')) as { seller: { username: string } };
      await page.click('#size-toggle');
      await page.waitFor('ul[id="size-menu"][style*="--display: block"]', 'visible');
      await page.click(`ul[id="size-menu"] [role="option"]:text-is("${option}")`);
      const size = await page.value('#size-input');
      const api = await page.apiGet(`${origin}/api/items?seller=${state.seller.username}`);
      await page.click('#next');
      await page.waitForPath(/^\/done\/$/);
      return {
        seller: state.seller.username,
        size,
        api: api.body,
        done: await page.text('[data-testid="done"]'),
      };
    });

let server: Server;
let origin: string;
let browser: Browser;
const posts: string[] = [];
const privateTexts = new Set<string>();

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.method !== 'GET') {
      posts.push(request.url ?? '');
      response.writeHead(204).end();
      return;
    }
    if (request.url === '/sell/')
      response.writeHead(200, { 'content-type': 'text/html' }).end(FORM);
    else if (request.url === '/done/')
      response.writeHead(200, { 'content-type': 'text/html' }).end(DONE);
    else if (request.url?.startsWith('/api/items')) {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(
          JSON.stringify({ products: [{ slug: 'jdoe_seller-blue-tee', seller_id: 4815162342 }] }),
        );
    } else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  browser = await (await loadChromium()).launch();
});

afterAll(async () => {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
});

const profile = () => ({
  ...standInProfile(automationProfile('depop'), origin),
  pacing: QUICK_PACING,
});

/** Records `script` on the local page, as the recorder does on the seller's tab. */
async function recordLive(
  script: Script<unknown>,
  host: RecordingHost,
): Promise<ExpandedRecording> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const inner =
      host === 'phone'
        ? new BridgeBackend(new PlaywrightPhoneHost(page))
        : new PlaywrightBackend(
            context,
            page,
            {
              profile: profile(),
              pacing: new Pacing(QUICK_PACING),
              screenshots: new MemoryScreenshotStore(),
              logger: silentLogger,
              stepTimeoutMs: 5_000,
              accountId: 'recording',
              runId: 'test',
              network: new NetworkLog(),
              onClosed: () => undefined,
            },
            silentLogger,
          );
    const backend = new RecordingBackend(inner, ['[data-testid="done"]']);
    const session = new ScriptSession(backend, {
      profile: profile(),
      pacing: new Pacing(QUICK_PACING),
      logger: silentLogger,
      stepTimeoutMs: 5_000,
      close: () => Promise.resolve<SessionCookie[]>([]),
    });
    const result = await session.run('test', script, new AbortController().signal);
    if (!result.ok) throw new Error(`the live run failed: ${JSON.stringify(result.failure)}`);
    await backend.capture();
    for (const text of backend.privateTexts) privateTexts.add(text);
    return {
      format: RECORDING_FORMAT,
      marketplace: 'depop',
      name: 'test',
      page: 'sell-form',
      host,
      recordedOn: '2026-10-27',
      input: null,
      result: { ok: true, value: JSON.parse(JSON.stringify(result.value)) as unknown },
      steps: result.steps,
      events: backend.events,
      states: backend.states,
      api: backend.api,
    };
  } finally {
    await context.close();
  }
}

const replay = (recording: ExpandedRecording, script: Script<unknown>) =>
  replayRecording(
    browser,
    recording,
    { profile: profile(), stepTimeoutMs: 5_000, read: false },
    script,
  );

describe.each(RECORDING_HOSTS)('recorded pages, through the %s backend', (host) => {
  let live: ExpandedRecording;
  let recording: ExpandedRecording;

  beforeAll(async () => {
    live = await recordLive(sellScript(), host);
    const redacted = redactRecordings([live], {
      identity: ['jdoe_seller'],
      privateTexts: [...privateTexts],
    }).recordings[0];
    if (redacted === undefined) throw new Error('no recording');
    // Through the file format: compacted, written, and read back.
    recording = expandRecording(
      parseRecording(
        JSON.parse(JSON.stringify({ ...redacted, states: compactStates(redacted.states) })),
      ),
    );
  });

  it('keeps the live page: its elements, form state, hidden parts, data, and API reads', () => {
    expect(live.result).toEqual({
      ok: true,
      value: {
        seller: 'jdoe_seller',
        size: 'M',
        api: { products: [{ slug: 'jdoe_seller-blue-tee', seller_id: 4815162342 }] },
        done: 'Listed by jdoe_seller',
      },
    });
    expect(live.events.map((event) => event.op)).toEqual(['goto', 'click', 'click', 'click']);
    const form = live.states[live.events[2]?.state ?? -1]?.lines.join('\n') ?? '';
    // The value the page's script set, the menu it closed, the field its CSS made invisible.
    expect(form).toContain('<input id="size-input" readonly value="M"');
    expect(form).toMatch(/<ul id="size-menu" class="closed" data-replay-hidden/);
    expect(form).toMatch(/id="hidden-login" data-replay-transparent/);
    // No script of the page's own, and no stylesheet.
    expect(form).not.toContain('addEventListener');
    expect(form).not.toContain('<style');
    expect(live.states[0]?.data).toEqual({
      __STATE__: { seller: { username: 'jdoe_seller', email: 'jdoe@gmail.com' }, items: 3 },
    });
    expect(live.api).toHaveLength(1);
    expect([...privateTexts]).toEqual(['Listed by jdoe_seller']);
  });

  it('redacts who the seller is everywhere, the same way each time', () => {
    const text = JSON.stringify(recording);
    expect(text).not.toMatch(/jdoe|gmail|4815162342|cdn\.example\.com/);
    expect(unredacted(recording, ['jdoe_seller'])).toEqual([]);
    expect(recording.result).toMatchObject({
      ok: true,
      // The private part's text is a placeholder in the result and on the page alike.
      value: {
        seller: 'redacteduser1',
        done: 'RedactedName1',
        api: { products: [{ slug: 'redacteduser1-blue-tee' }] },
      },
    });
    expect(text).toContain('>RedactedName1</h1');
    expect(text).toContain(String.raw`href=\"/redacteduser1/\"`);
    expect(text).toContain('https://images.recorded.invalid/1.jpg');
    expect(unredacted(live, ['jdoe_seller'])).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^a user value under its key/),
        'an email address',
        'a word that identifies the seller',
      ]),
    );
  });

  it('runs the script on the recording as it ran live', async () => {
    const replayed = await replay(recording, sellScript());
    expect(replayed.divergences).toEqual([]);
    expect(replayed.result).toMatchObject({
      ok: true,
      value: recording.result.ok ? recording.result.value : null,
    });
  });

  it('fails as it would live when the recorded page lost what the script needs', async () => {
    const changed: ExpandedRecording = {
      ...recording,
      states: recording.states.map((state) => ({
        ...state,
        lines: state.lines.map((line) => line.replaceAll('id="size-toggle"', 'id="size-picker"')),
      })),
    };
    const replayed = await replay(changed, sellScript());
    expect(replayed.result).toMatchObject({
      ok: false,
      failure: { kind: 'error', code: 'element_missing' },
    });
  });

  it('catches a script that acts differently from the recording', async () => {
    const replayed = await replay(recording, sellScript('S'));
    expect(replayed.result.ok).toBe(false);
    expect(replayed.divergences).toEqual([
      expect.stringMatching(
        /clicked .*:text-is\("S"\) where the recording clicked .*:text-is\("M"\)/,
      ),
    ]);
  });

  it('stops at a check the recorded page shows', async () => {
    const checked: ExpandedRecording = {
      ...recording,
      states: recording.states.map((state, index) =>
        index === 0
          ? {
              ...state,
              lines: state.lines.map((line) =>
                line.replace('>Sell</title', '>Just a moment...</title'),
              ),
            }
          : state,
      ),
    };
    const replayed = await replay(checked, sellScript());
    expect(replayed.result).toMatchObject({
      ok: false,
      failure: { kind: 'challenge', challenge: 'bot_check' },
    });
  });

  it("blocks a photo upload from a recording session's tab, and lets the page's own reads through", async () => {
    posts.length = 0;
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const blocked = await guardTab(page);
      await page.goto(`${origin}/sell/`);
      const sent = await page.evaluate(async (url) => {
        const send = (body: FormData | string) =>
          fetch(url, { method: 'POST', body }).then(
            () => 'sent',
            () => 'blocked',
          );
        const photo = new FormData();
        photo.append(
          'photo',
          new Blob([new Uint8Array([0xff, 0xd8])], { type: 'image/jpeg' }),
          'front.jpg',
        );
        return [await send(photo), await send(JSON.stringify({ query: '{ categories }' }))];
      }, `${origin}/api/graphql`);
      expect(sent).toEqual(['blocked', 'sent']);
      expect(posts).toEqual(['/api/graphql']);
      expect(Object.fromEntries(blocked)).toEqual({ [`POST ${origin}`]: 1 });
    } finally {
      await context.close();
    }
  });
});
