import { describe, expect, it } from 'vitest';

import { inspectPage, type PageSignals } from '../safety/challenges.ts';
import { automationProfile } from '../profiles.ts';

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
      // Its web API is on its own origin (the listings and orders reads, M4).
      apiOrigins: ['https://www.vinted.com'],
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
