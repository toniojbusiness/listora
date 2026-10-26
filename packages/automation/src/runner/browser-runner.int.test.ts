/**
 * The browser runner against the fake marketplace site in a real headless Chromium: session
 * lifecycle, step timeouts, screenshots, pacing, checks it must stop at, and cookie rotation.
 * No real marketplace is contacted.
 */
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { FakeAutomationSite } from '../fake-site/fake-site.ts';
import type { AutomationProfile } from '../profiles.ts';
import { createLogger } from '@listora/shared';

import { fakeSiteProfile, testRunner } from '../test-support.ts';
import { PlaywrightBrowserRunner } from './browser-runner.ts';
import { PageChangedError } from './errors.ts';
import type { PlaywrightSession } from './session.ts';
import type { AutomationSession } from './types.ts';

describe('PlaywrightBrowserRunner (headless Chromium, fake site)', () => {
  let site: FakeAutomationSite;
  let profile: AutomationProfile;
  const { runner, screenshots } = testRunner({ stepTimeoutMs: 3_000 });
  const open: AutomationSession[] = [];
  let runs = 0;

  beforeAll(async () => {
    site = await FakeAutomationSite.start();
    profile = fakeSiteProfile(site);
  });

  afterEach(async () => {
    site.clearFaults();
    await Promise.all(open.splice(0).map((session) => session.close()));
  });

  afterAll(async () => {
    await runner.close();
    await site.close();
  });

  async function session(cookies = [site.issueSession()], spec: Partial<AutomationProfile> = {}) {
    runs += 1;
    const opened = await runner.openSession(
      {
        profile: { ...profile, ...spec },
        cookies,
        accountId: 'acct',
        runId: `run-${String(runs)}`,
      },
      new AbortController().signal,
    );
    open.push(opened);
    return opened;
  }

  const signal = () => new AbortController().signal;

  it("opens a session with the seller's cookies, runs named steps, and reads the page back", async () => {
    const browser = await session([site.issueSession('closet-ana')]);
    const result = await browser.run(
      'account',
      async (step) => {
        await step('open the account', { mutates: false }, (page) => page.goto(`${site.url}/`));
        return step('read the seller', { mutates: false }, (page) =>
          page.attribute('[data-account]', 'data-account'),
        );
      },
      signal(),
    );
    expect(result).toEqual({
      ok: true,
      value: 'closet-ana',
      mutated: false,
      steps: ['open the account', 'read the seller'],
    });
    // The browser says what it is: no disguise, no stealth.
    const seen = site.requests.filter((request) => request.path === '/');
    expect(seen.at(-1)?.userAgent).toContain('HeadlessChrome');

    const cookies = await browser.close();
    expect(cookies.map((cookie) => cookie.name)).toEqual(['fake_sid']);
    // A closed session runs nothing more.
    expect(await browser.run('again', async () => 'never', signal())).toMatchObject({
      ok: false,
      failure: { kind: 'error', code: 'aborted' },
    });
  });

  it('fills, uploads, and submits a form, and only the submitting step mutates', async () => {
    const browser = await session();
    const result = await browser.run(
      'create',
      async (step) => {
        await step('fill in the listing', { mutates: false }, async (page) => {
          await page.goto(`${site.url}/listings/new`);
          await page.fill('#title', 'Denim jacket');
          await page.fill('#description', 'Blue, size M.');
          await page.type('#price', '45.00');
          await page.fill('#sku', 'SKU-FORM-1');
          await page.upload('#photos', [
            { name: 'front.jpg', mimeType: 'image/jpeg', bytes: Buffer.from([0xff, 0xd8]) },
          ]);
        });
        return step('publish', { mutates: true }, async (page) => {
          await page.click('#save');
          await page.waitForPath(/^\/listings\/L\d+$/);
          return page.attribute('article', 'data-listing-id');
        });
      },
      signal(),
    );
    expect(result).toMatchObject({
      ok: true,
      mutated: true,
      steps: ['fill in the listing', 'publish'],
    });
    expect(site.listings('SKU-FORM-1')).toEqual([
      expect.objectContaining({ title: 'Denim jacket', priceCents: 4500, photoCount: 1 }),
    ]);
  });

  it('waits a paced delay before every action and between keystrokes', async () => {
    const browser = await session([site.issueSession()], {
      pacing: { actionDelayMs: [120, 140], keystrokeDelayMs: [30, 40], sessionGapMs: [0, 0] },
    });
    const started = Date.now();
    const result = await browser.run(
      'paced',
      (step) =>
        step('two pages and a search', { mutates: false }, async (page) => {
          await page.goto(`${site.url}/`);
          await page.goto(`${site.url}/listings/new`);
          await page.type('#sku', 'abcd');
        }),
      signal(),
    );
    expect(result.ok).toBe(true);
    // Three paced actions (at least 120 ms each) and four keystrokes (at least 30 ms each).
    expect(Date.now() - started).toBeGreaterThanOrEqual(3 * 120 + 4 * 30);
    const pages = site.requests.filter((request) => request.at >= started);
    const [first, second] = pages;
    expect(
      second !== undefined && first !== undefined && second.at - first.at,
    ).toBeGreaterThanOrEqual(120);
  });

  it('times a slow step out, with a redacted screenshot of the page', async () => {
    const browser = await session();
    site.inject({ action: 'health', fault: { type: 'slow', delayMs: 10_000, afterApply: false } });
    const result = await browser.run(
      'slow',
      async (step) => {
        await step('fill a field', { mutates: false }, async (page) => {
          await page.goto(`${site.url}/listings/new`);
          await page.fill('#title', 'secret-typed-value');
        });
        await step('open a slow page', { mutates: false, timeoutMs: 800 }, (page) =>
          page.goto(`${site.url}/`),
        );
      },
      signal(),
    );
    expect(result).toMatchObject({
      ok: false,
      mutated: false,
      failure: { kind: 'timeout', step: 'open a slow page' },
    });
    const key = result.ok ? null : result.failure.screenshotKey;
    expect(key).toMatch(/^automation\/acct\/run-\d+-1\.png$/);
    const png = screenshots.saved.get(key ?? '');
    expect(png?.subarray(1, 4).toString()).toBe('PNG');
  });

  it('blacks out form fields in screenshots', async () => {
    const browser = await session();
    const result = await browser.run(
      'masked',
      async (step) => {
        await step('fill a field', { mutates: false }, async (page) => {
          await page.goto(`${site.url}/listings/new`);
          await page.fill('#title', 'A private title nobody may see');
        });
        await step('fail on purpose', { mutates: false, timeoutMs: 600 }, (page) =>
          page.click('#not-on-this-page'),
        );
      },
      signal(),
    );
    expect(result).toMatchObject({
      ok: false,
      failure: { kind: 'error', code: 'element_missing', step: 'fail on purpose' },
    });
    const png = screenshots.saved.get(result.ok ? '' : (result.failure.screenshotKey ?? ''));
    if (png === undefined) throw new Error('no screenshot');
    // The page is still the form; every pixel of the title field is black in the screenshot.
    const box = await (browser as PlaywrightSession).page.locator('#title').boundingBox();
    if (box === null) throw new Error('no title field');
    const { data, info } = await sharp(png)
      .extract({
        left: Math.ceil(box.x) + 1,
        top: Math.ceil(box.y) + 1,
        width: Math.floor(box.width) - 2,
        height: Math.floor(box.height) - 2,
      })
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(info.width).toBeGreaterThan(10);
    expect(data.every((value, index) => index % info.channels === 3 || value === 0)).toBe(true);
  });

  it.each([
    ['captcha', { type: 'captcha' }, 'captcha'],
    ['bot check', { type: 'bot_check' }, 'bot_check'],
    ['verification step', { type: 'login_challenge' }, 'login_challenge'],
    ['rejected session', { type: 'session_expired' }, 'session_rejected'],
    ['page off the site', { type: 'offsite' }, 'unexpected_page'],
  ] as const)('stops at a %s and does nothing after it', async (_name, fault, kind) => {
    const browser = await session();
    site.inject({ action: 'health', fault });
    let afterwards = false;
    const result = await browser.run(
      'checked',
      async (step) => {
        await step('open the account', { mutates: false }, (page) => page.goto(`${site.url}/`));
        afterwards = true;
        await step('go on', { mutates: true }, (page) => page.goto(`${site.url}/listings/new`));
      },
      signal(),
    );
    expect(result).toMatchObject({
      ok: false,
      mutated: false,
      steps: ['open the account'],
      failure: { kind: 'challenge', challenge: kind, step: 'open the account' },
    });
    expect(afterwards).toBe(false);
    // A page off the marketplace is never kept, whatever it shows.
    expect(result.ok ? null : result.failure.screenshotKey).toEqual(
      kind === 'unexpected_page' ? null : expect.any(String),
    );

    // The session refuses every later run without touching the page.
    const requests = site.requests.length;
    expect(
      await browser.read(
        'later',
        (step) => step('read', { mutates: false }, (page) => page.goto(`${site.url}/`)),
        signal(),
      ),
    ).toMatchObject({ ok: false, failure: { kind: 'challenge', challenge: kind } });
    expect(site.requests).toHaveLength(requests);
  });

  it('sends nothing to another origin on a private address, and keeps the main frame on the site', async () => {
    const browser = await session();
    const before = site.requests.length;
    site.inject({ action: 'health', fault: { type: 'offsite_content' } });
    const result = await browser.run(
      'offsite content',
      async (step) => {
        await step('open the account', { mutates: false }, (page) => page.goto(`${site.url}/`));
        const seller = await step('read the seller', { mutates: false }, (page) =>
          page.attribute('[data-account]', 'data-account'),
        );
        await step('follow the link', { mutates: false }, (page) => page.click('#offsite-link'));
        return seller;
      },
      signal(),
    );
    expect(result).toMatchObject({
      ok: false,
      steps: ['open the account', 'read the seller', 'follow the link'],
      failure: { step: 'follow the link', screenshotKey: null },
    });
    const elsewhere = new URL(site.url.replace('127.0.0.1', 'localhost')).host;
    const sent = site.requests.slice(before);
    expect(sent.map((request) => request.path)).toContain('/');
    expect(sent.filter((request) => request.host === elsewhere)).toEqual([]);
  });

  it('logs, by origin, what the network rules refused and what the site answered with errors', async () => {
    // So a page that broke in the runner shows whether Listora's rules or the marketplace did it.
    const lines: Record<string, unknown>[] = [];
    const logged = new PlaywrightBrowserRunner({
      logger: createLogger({
        service: 'automation-test',
        level: 'warn',
        destination: {
          write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>),
        },
      }),
      screenshots,
      stepTimeoutMs: 3_000,
    });
    const elsewhere = new URL(site.url.replace('127.0.0.1', 'localhost')).origin;
    try {
      const browser = await logged.openSession(
        { profile, cookies: [site.issueSession()], accountId: 'acct', runId: 'run-network' },
        signal(),
      );
      site.inject({ action: 'health', fault: { type: 'offsite_content' } });
      const result = await browser.run(
        'offsite content',
        async (step) => {
          await step('open the account', { mutates: false }, (page) => page.goto(`${site.url}/`));
          await step('follow the link', { mutates: false }, (page) => page.click('#offsite-link'));
        },
        signal(),
      );
      await browser.close();
      expect(result.ok).toBe(false);
      const stopped = lines.find((line) => line['msg'] === 'automation script stopped');
      expect(stopped?.['network']).toMatchObject({
        refused: { [elsewhere]: expect.any(Number) as number },
      });
      // The image, the frame, the fetch, and the link: every one refused, and only the origin kept.
      const refused = (stopped?.['network'] as { refused: Record<string, number> }).refused;
      expect(refused[elsewhere]).toBeGreaterThanOrEqual(3);
      expect(JSON.stringify(stopped)).not.toContain('elsewhere');

      const second = await logged.openSession(
        { profile, cookies: [site.issueSession()], accountId: 'acct', runId: 'run-errors' },
        signal(),
      );
      site.inject({ action: 'health', fault: { type: 'server_error' } });
      await second.run(
        'broken',
        (step) => step('open the account', { mutates: false }, (page) => page.goto(`${site.url}/`)),
        signal(),
      );
      await second.close();
      const broken = lines.filter((line) => line['msg'] === 'automation script stopped').at(-1);
      expect(broken?.['network']).toEqual({ errors: { [`${new URL(site.url).origin} 500`]: 1 } });
    } finally {
      await logged.close();
    }
  });

  it('logs what a page it no longer understands has instead, structure only', async () => {
    // So the one page module that names the missing part can be fixed against the real page.
    const lines: Record<string, unknown>[] = [];
    const logged = new PlaywrightBrowserRunner({
      logger: createLogger({
        service: 'automation-test',
        level: 'warn',
        destination: {
          write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>),
        },
      }),
      screenshots,
      stepTimeoutMs: 3_000,
    });
    try {
      const seller = `seller${String(Date.now())}`;
      const browser = await logged.openSession(
        { profile, cookies: [site.issueSession(seller)], accountId: 'acct', runId: 'run-changed' },
        signal(),
      );
      const result = await browser.read(
        'changed page',
        (step) =>
          step('open the account', { mutates: false }, async (page) => {
            await page.goto(`${site.url}/`);
            if (!(await page.exists('[data-testid="MyPage"]'))) {
              throw new PageChangedError('the account page has no account section');
            }
          }),
        signal(),
      );
      await browser.close();
      expect(result).toMatchObject({ ok: false, failure: { code: 'element_missing' } });
      const stopped = lines.find((line) => line['msg'] === 'automation script stopped');
      expect(stopped?.['evidence']).toEqual({
        path: '/',
        title: 'Your account',
        testIds: [],
        links: [],
        requests: [],
        scripts: [],
        data: [],
      });
      expect(JSON.stringify(lines)).not.toContain(seller);
    } finally {
      await logged.close();
    }
  });

  it('stops at a check even when the script catches the error and tries to go on', async () => {
    const browser = await session();
    site.inject({ action: 'health', fault: { type: 'captcha' } });
    const before = site.requests.length;
    const result = await browser.run(
      'stubborn',
      async (step) => {
        try {
          await step('open the account', { mutates: false }, (page) => page.goto(`${site.url}/`));
        } catch {
          // A script must not be able to work around the check.
        }
        const requests = site.requests.length;
        const reached = await step('try another page', { mutates: true }, async (page) => {
          await page.goto(`${site.url}/listings/new`).catch(() => undefined);
          return site.requests.length > requests;
        }).catch(() => false);
        return reached ? 'went on' : 'stopped';
      },
      signal(),
    );
    expect(result).toMatchObject({
      ok: false,
      failure: { kind: 'challenge', challenge: 'captcha' },
    });
    expect(
      site.requests.slice(before).filter((request) => request.path === '/listings/new'),
    ).toEqual([]);
  });

  it('reports a rate limit with its Retry-After, and a marketplace error, as retryable', async () => {
    const browser = await session();
    site.inject({ action: 'health', fault: { type: 'rate_limited', retryAfterSeconds: 7 } });
    const go = (step: Parameters<Parameters<AutomationSession['run']>[1]>[0]) =>
      step('open the account', { mutates: false }, (page) => page.goto(`${site.url}/`));
    expect(await browser.run('limited', go, signal())).toMatchObject({
      ok: false,
      failure: { kind: 'error', code: 'rate_limited', retryAfterMs: 7_000 },
    });
    site.inject({ action: 'health', fault: { type: 'server_error' } });
    expect(await browser.run('broken', go, signal())).toMatchObject({
      ok: false,
      failure: { kind: 'error', code: 'server_error' },
    });
    expect(await browser.run('fine', go, signal())).toMatchObject({ ok: true });
  });

  it('keeps scripts on the marketplace, and reads from changing anything', async () => {
    const browser = await session();
    expect(
      await browser.run(
        'away',
        (step) => step('leave', { mutates: false }, (page) => page.goto('https://example.com/')),
        signal(),
      ),
    ).toMatchObject({ ok: false, failure: { kind: 'error', code: 'script_error' } });
    expect(
      await browser.read(
        'sneaky',
        (step) =>
          step('type in a read', { mutates: false }, async (page) => {
            await page.goto(`${site.url}/listings/new`);
            await page.fill('#title', 'no');
          }),
        signal(),
      ),
    ).toMatchObject({ ok: false, failure: { kind: 'error', code: 'script_error' } });
    expect(
      await browser.read(
        'mutating',
        (step) => step('delete', { mutates: true }, async () => undefined),
        signal(),
      ),
    ).toMatchObject({ ok: false, failure: { kind: 'error', code: 'script_error' } });
  });

  it('never repeats typed values in error messages', async () => {
    const browser = await session();
    const result = await browser.run(
      'oops',
      (step) =>
        step('fill then break', { mutates: false }, async (page) => {
          await page.goto(`${site.url}/listings/new`);
          await page.fill('#title', 'hunter2-private');
          throw new Error('failed with hunter2-private at https://127.0.0.1:1/closet/ana?x=1');
        }),
      signal(),
    );
    expect(result).toMatchObject({ ok: false, failure: { kind: 'error', code: 'script_error' } });
    const message = result.ok || result.failure.kind !== 'error' ? '' : result.failure.message;
    expect(message).not.toContain('hunter2-private');
    expect(message).not.toContain('/closet/ana');
  });

  it('returns the cookies the site refreshed, which replace the old session', async () => {
    const rotating = await FakeAutomationSite.start(0, { rotateSessionEvery: 2 });
    try {
      const original = rotating.issueSession();
      runs += 1;
      const browser = await runner.openSession(
        {
          profile: fakeSiteProfile(rotating),
          cookies: [original],
          accountId: 'acct',
          runId: `run-${String(runs)}`,
        },
        signal(),
      );
      const result = await browser.run(
        'browse',
        (step) =>
          step('browse', { mutates: false }, async (page) => {
            await page.goto(`${rotating.url}/`);
            await page.goto(`${rotating.url}/listings/new`);
            await page.goto(`${rotating.url}/`);
          }),
        signal(),
      );
      expect(result.ok).toBe(true);
      const cookies = await browser.close();
      const refreshed = cookies.find((cookie) => cookie.name === 'fake_sid');
      expect(refreshed?.value).not.toBe(original.value);
      expect(rotating.sessionValid(original.value)).toBe(false);
      expect(rotating.sessionValid(refreshed?.value ?? '')).toBe(true);
    } finally {
      await rotating.close();
    }
  });

  it('runs one session at a time', async () => {
    const first = await session();
    let secondOpened = false;
    const second = runner
      .openSession(
        { profile, cookies: [site.issueSession()], accountId: 'acct', runId: 'second' },
        signal(),
      )
      .then((opened) => {
        secondOpened = true;
        open.push(opened);
        return opened;
      });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(secondOpened).toBe(false);
    await first.close();
    await second;
    expect(secondOpened).toBe(true);
  });

  it('stops a run when its signal aborts, without a screenshot', async () => {
    const browser = await session();
    site.inject({ action: 'health', fault: { type: 'slow', delayMs: 5_000, afterApply: false } });
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort(new Error('deadline'));
    }, 300);
    const result = await browser.run(
      'aborted',
      (step) => step('open a slow page', { mutates: true }, (page) => page.goto(`${site.url}/`)),
      controller.signal,
    );
    expect(result).toMatchObject({
      ok: false,
      mutated: true,
      failure: { kind: 'error', code: 'aborted', screenshotKey: null },
    });
  });
});
