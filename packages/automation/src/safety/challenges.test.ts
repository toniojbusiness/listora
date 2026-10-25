import { describe, expect, it } from 'vitest';

import { automationProfile, standInProfile } from '../profiles.ts';
import { challengeMessage, inspectPage, type PageSignals } from './challenges.ts';

const profile = automationProfile('poshmark');

function signals(overrides: Partial<PageSignals> = {}): PageSignals {
  return {
    url: 'https://poshmark.com/closet/seller',
    status: 200,
    retryAfterSeconds: null,
    title: 'My closet',
    challengeFrames: [],
    hasPasswordField: false,
    matchedSelectors: [],
    text: 'my closet 12 listings',
    ...overrides,
  };
}

describe('inspectPage', () => {
  it('lets an ordinary marketplace page through', () => {
    expect(inspectPage(signals(), profile)).toBeNull();
    expect(inspectPage(signals({ url: 'https://www.poshmark.com/feed' }), profile)).toBeNull();
    expect(inspectPage(signals({ status: 404 }), profile)).toBeNull();
    expect(inspectPage(signals({ status: 410 }), profile)).toBeNull();
  });

  it('stops at CAPTCHA widgets and frames', () => {
    expect(inspectPage(signals({ challengeFrames: ['https://www.google.com'] }), profile)).toEqual({
      type: 'challenge',
      kind: 'captcha',
      sign: 'frame https://www.google.com',
    });
    expect(inspectPage(signals({ matchedSelectors: ['.h-captcha'] }), profile)).toMatchObject({
      kind: 'captcha',
    });
  });

  it.each([
    ['Just a moment...', ''],
    ['Attention Required! | Cloudflare', ''],
    ['Access Denied', ''],
    ['Pardon Our Interruption', ''],
    ['Poshmark', 'please verify you are a human to continue'],
    ['Poshmark', 'we have detected unusual traffic from your network'],
    ['Poshmark', 'press & hold to confirm you are a human (and not a bot).'],
  ])('stops at a bot check (%s %s)', (title, text) => {
    expect(inspectPage(signals({ title, text }), profile)).toMatchObject({
      type: 'challenge',
      kind: 'bot_check',
    });
  });

  it('stops at a 403, which marketplaces answer to a blocked browser', () => {
    expect(inspectPage(signals({ status: 403 }), profile)).toMatchObject({ kind: 'bot_check' });
  });

  it('stops at a verification step and at a login page', () => {
    expect(
      inspectPage(signals({ url: 'https://poshmark.com/verify/email' }), profile),
    ).toMatchObject({
      kind: 'login_challenge',
    });
    expect(
      inspectPage(signals({ text: 'enter the 6-digit code we sent to your phone' }), profile),
    ).toMatchObject({ kind: 'login_challenge' });
    expect(
      inspectPage(signals({ url: 'https://poshmark.com/login?next=/feed' }), profile),
    ).toMatchObject({ kind: 'session_rejected' });
    expect(inspectPage(signals({ hasPasswordField: true }), profile)).toMatchObject({
      kind: 'session_rejected',
    });
  });

  it("stops anywhere off the marketplace's own site", () => {
    for (const url of [
      'https://accounts.google.com/signin',
      'http://poshmark.com/closet',
      'https://poshmark.com.evil.test/',
      'not a url',
    ]) {
      expect(inspectPage(signals({ url }), profile), url).toMatchObject({
        type: 'challenge',
        kind: 'unexpected_page',
      });
    }
    expect(inspectPage(signals({ url: 'about:blank' }), profile)).toBeNull();
  });

  it('puts checks before rate limits and errors', () => {
    expect(inspectPage(signals({ status: 503, title: 'Just a moment...' }), profile)).toMatchObject(
      { type: 'challenge', kind: 'bot_check' },
    );
    expect(inspectPage(signals({ status: 429, retryAfterSeconds: 30 }), profile)).toEqual({
      type: 'rate_limited',
      retryAfterMs: 30_000,
    });
    expect(inspectPage(signals({ status: 429 }), profile)).toEqual({
      type: 'rate_limited',
      retryAfterMs: null,
    });
    expect(inspectPage(signals({ status: 502 }), profile)).toEqual({
      type: 'server_error',
      status: 502,
    });
  });

  it("applies a stand-in site's origin, and the marketplace's own signs", () => {
    const local = standInProfile(profile, 'http://127.0.0.1:4300/');
    expect(inspectPage(signals({ url: 'http://127.0.0.1:4300/' }), local)).toBeNull();
    expect(inspectPage(signals(), local)).toMatchObject({ kind: 'unexpected_page' });
    const strict = {
      ...profile,
      challenges: { ...profile.challenges, loginPaths: [/^\/account\/enter/] },
    };
    expect(
      inspectPage(signals({ url: 'https://poshmark.com/account/enter' }), strict),
    ).toMatchObject({ kind: 'session_rejected' });
  });
});

describe('challengeMessage', () => {
  it('tells the seller what happened and how to go on, and never offers to get past it', () => {
    for (const kind of [
      'captcha',
      'bot_check',
      'login_challenge',
      'session_rejected',
      'unexpected_page',
    ] as const) {
      const message = challengeMessage(kind, 'Poshmark');
      expect(message, kind).toContain('Poshmark');
      expect(message.toLowerCase(), kind).toContain('log in to poshmark again');
    }
  });
});
