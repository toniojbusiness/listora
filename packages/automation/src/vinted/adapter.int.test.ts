/**
 * The Vinted automation adapter's session check on the fake Vinted site, in a real headless
 * Chromium (Vinted plan M3): it passes on a signed-in session and reads the member it is signed
 * in as, and it stops at Vinted's checks (DataDome, a CAPTCHA, a sign-in code, a signed-out
 * session) without ever passing one. Every listing step stays the seller's assisted task. No
 * traffic goes to Vinted; the pages are invented until the mapping (M2) records the real ones.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { AdapterContext } from '@listora/marketplaces';

import { automationProfile } from '../profiles.ts';
import { PlaywrightBrowserRunner } from '../runner/browser-runner.ts';
import { MemoryScreenshotStore } from '../runner/screenshots.ts';
import { FakeSiteSessions, QUICK_PACING, silentLogger } from '../test-support.ts';
import { createVintedAutomationAdapter } from './adapter.ts';
import { FakeVintedSite, type FakeVintedFault } from './fake/fake-vinted-site.ts';

const connection = { id: 'connection-vinted', mode: 'automation', status: 'connected' } as const;
const ctx = (): AdapterContext => ({ signal: new AbortController().signal, connection });

describe('Vinted automation adapter on the fake Vinted site', () => {
  let site: FakeVintedSite;
  let runner: PlaywrightBrowserRunner;
  let sessions: FakeSiteSessions;
  let adapter: ReturnType<typeof createVintedAutomationAdapter>;
  /** The login the next session is signed in as. */
  let login = 'Vinted-Test.Shop';

  beforeAll(async () => {
    site = await FakeVintedSite.start(0);
    runner = new PlaywrightBrowserRunner({
      logger: silentLogger,
      screenshots: new MemoryScreenshotStore(),
      stepTimeoutMs: 3_000,
    });
    const profile = { ...automationProfile('vinted'), pacing: QUICK_PACING };
    sessions = new FakeSiteSessions({ issueSession: () => site.issueSession(login) }, runner, {
      ...profile,
      origins: [site.url],
      cookieDomains: ['127.0.0.1'],
    });
    adapter = createVintedAutomationAdapter({
      siteUrl: site.url,
      profile,
      sessions,
      logger: silentLogger,
    });
  });

  afterEach(() => {
    site.clearFaults();
    sessions.challenges.length = 0;
    login = 'Vinted-Test.Shop';
  });

  afterAll(async () => {
    await runner.close();
    await site.close();
  });

  const inject = (fault: FakeVintedFault) => {
    site.injectFault({ action: 'health', fault });
  };

  it('passes on a signed-in session and reads the member, lower-cased', async () => {
    expect(await adapter.healthCheck(ctx())).toEqual({
      status: 'ok',
      sellerId: 'vinted-test.shop',
    });
    expect(sessions.requests.at(-1)).toMatchObject({ purpose: 'health' });
  });

  it('reads a login with characters a URL escapes', async () => {
    login = 'shop ñ';
    expect(await adapter.healthCheck(ctx())).toEqual({ status: 'ok', sellerId: 'shop ñ' });
  });

  it('leaves the member unknown when the profile link names no login, never a guess', async () => {
    inject({ type: 'no_login' });
    expect(await adapter.healthCheck(ctx())).toEqual({ status: 'ok' });
  });

  it('cannot check a page that is not as Listora knows it, and keeps the session', async () => {
    inject({ type: 'redesigned' });
    expect(await adapter.healthCheck(ctx())).toMatchObject({
      status: 'degraded',
      code: 'element_missing',
    });
    expect(sessions.challenges).toEqual([]);
  });

  it.each([
    ['DataDome', { type: 'datadome' }, 'captcha'],
    ['a CAPTCHA', { type: 'captcha' }, 'captcha'],
    ['a sign-in code', { type: 'login_challenge' }, 'login_challenge'],
    ['a signed-out session', { type: 'session_expired' }, 'session_rejected'],
  ] satisfies [string, FakeVintedFault, string][])(
    'stops at %s and asks the seller to link again',
    async (_name, fault, challenge) => {
      inject(fault);
      expect(await adapter.healthCheck(ctx())).toMatchObject({
        status: 'reauth_required',
        code: challenge,
      });
      expect(sessions.challenges).toEqual([challenge]);
    },
  );

  it.each([
    ['a rate limit', { type: 'rate_limited', retryAfterSeconds: 60 }, 'rate_limited'],
    ['an error page', { type: 'server_error' }, 'server_error'],
  ] satisfies [string, FakeVintedFault, string][])(
    'cannot check on %s, and keeps the session',
    async (_name, fault, code) => {
      inject(fault);
      expect(await adapter.healthCheck(ctx())).toMatchObject({ status: 'degraded', code });
      expect(sessions.challenges).toEqual([]);
    },
  );

  it('keeps every listing step the seller’s in the Vinted app', () => {
    expect(adapter.capabilities()).toMatchObject({
      connect: 'session',
      create: 'assisted',
      updatePrice: 'assisted',
      updateDetails: 'assisted',
      delist: 'assisted',
      relist: 'assisted',
      refresh: 'none',
    });
  });
});
