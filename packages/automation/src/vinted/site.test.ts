import { describe, expect, it } from 'vitest';

import { inspectPage, type PageSignals } from '../safety/challenges.ts';
import { automationProfile } from '../profiles.ts';
import { memberFromPath } from './site.ts';

describe('Vinted member paths', () => {
  it('reads the member id and the login after it', () => {
    expect(memberFromPath('/member/123456-janes.closet')).toEqual({
      id: '123456',
      login: 'janes.closet',
    });
    expect(memberFromPath('/member/123456-shop%20%C3%B1/')).toEqual({
      id: '123456',
      login: 'shop ñ',
    });
  });

  it('has no login for a link with only the id, or a slug that does not decode', () => {
    expect(memberFromPath('/member/123456')).toEqual({ id: '123456', login: null });
    expect(memberFromPath('/member/123456-%E0%A4%A')).toEqual({ id: '123456', login: null });
  });

  it('is no member for the sign-in chooser and other paths', () => {
    expect(memberFromPath('/member/signup/select_type')).toBeNull();
    expect(memberFromPath('/member/123/items')).toBeNull();
    expect(memberFromPath('/items/123-shirt')).toBeNull();
  });
});

describe('the Vinted profile', () => {
  const profile = automationProfile('vinted');
  const signals = (url: string, extra: Partial<PageSignals> = {}): PageSignals => ({
    url,
    status: 200,
    retryAfterSeconds: null,
    title: 'Vinted',
    challengeFrames: [],
    hasPasswordField: false,
    matchedSelectors: [],
    text: '',
    ...extra,
  });

  it('runs on the phone only, at a careful pace, on Vinted’s own site', () => {
    expect(profile).toMatchObject({
      runsOn: 'phone',
      cloudAllowed: false,
      origins: ['https://www.vinted.com', 'https://vinted.com'],
      cookieDomains: ['vinted.com'],
      apiOrigins: [],
      loginUrl: 'https://www.vinted.com/member/signup/select_type',
      emailsSignInLinks: false,
    });
    expect(profile.pacing.actionDelayMs[0]).toBeGreaterThanOrEqual(450);
    expect(profile.limits.runsPerHour).toBeLessThan(automationProfile('depop').limits.runsPerHour);
  });

  it('stops at Vinted’s sign-in chooser, its code step, and DataDome', () => {
    expect(
      inspectPage(signals('https://www.vinted.com/member/signup/select_type?ref_url=%2F'), profile),
    ).toMatchObject({ type: 'challenge', kind: 'session_rejected' });
    expect(
      inspectPage(signals('https://www.vinted.com/member/verification'), profile),
    ).toMatchObject({ type: 'challenge', kind: 'login_challenge' });
    expect(
      inspectPage(
        signals('https://www.vinted.com/settings/profile', {
          challengeFrames: ['https://geo.captcha-delivery.com'],
        }),
        profile,
      ),
    ).toMatchObject({ type: 'challenge', kind: 'captcha' });
  });

  it('goes on at the signed-in settings page', () => {
    expect(inspectPage(signals('https://www.vinted.com/settings/profile'), profile)).toBeNull();
  });
});
