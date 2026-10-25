import { describe, expect, it } from 'vitest';

import { DEFAULT_LIMITS, DEFAULT_PACING } from './profiles.ts';
import { AutomationConfigError, loadAutomationSettings } from './settings.ts';

const HOUR = 3_600_000;

describe('loadAutomationSettings', () => {
  it('has careful defaults: polite pacing, modest limits, a sale check every 12 hours', () => {
    const settings = loadAutomationSettings({});
    expect(settings).toMatchObject({
      stepTimeoutMs: 30_000,
      callTimeoutMs: 300_000,
      saleChecks: {
        defaultIntervalMs: 12 * HOUR,
        minIntervalMs: 2 * HOUR,
        maxIntervalMs: 24 * HOUR,
      },
      fakeSiteUrl: undefined,
    });
    for (const profile of Object.values(settings.profiles)) {
      expect(profile.pacing).toEqual(DEFAULT_PACING);
      expect(profile.limits).toEqual(DEFAULT_LIMITS);
    }
    expect(settings.profiles.poshmark.origins).toContain('https://poshmark.com');
  });

  it('sets pacing and limits per marketplace', () => {
    const settings = loadAutomationSettings({
      AUTOMATION_POSHMARK_PACE_MS: '1500-4000',
      AUTOMATION_POSHMARK_SESSION_GAP_MS: '10000-30000',
      AUTOMATION_POSHMARK_RUNS_PER_HOUR: '10',
      AUTOMATION_MERCARI_RUNS_PER_DAY: '50',
      SALE_CHECK_DEFAULT_HOURS: '8',
      SALE_CHECK_MIN_HOURS: '1.5',
    });
    expect(settings.profiles.poshmark.pacing.actionDelayMs).toEqual([1500, 4000]);
    expect(settings.profiles.poshmark.pacing.sessionGapMs).toEqual([10_000, 30_000]);
    expect(settings.profiles.poshmark.limits).toEqual({ runsPerHour: 10, runsPerDay: 200 });
    expect(settings.profiles.mercari.limits).toEqual({ runsPerHour: 30, runsPerDay: 50 });
    expect(settings.profiles.depop.pacing).toEqual(DEFAULT_PACING);
    expect(settings.saleChecks).toMatchObject({
      defaultIntervalMs: 8 * HOUR,
      minIntervalMs: 1.5 * HOUR,
    });
  });

  it('refuses anything faster than the pacing floor or above the limit ceiling', () => {
    let error: unknown;
    try {
      loadAutomationSettings({
        AUTOMATION_DEPOP_PACE_MS: '0-10',
        AUTOMATION_DEPOP_SESSION_GAP_MS: '0-0',
        AUTOMATION_DEPOP_RUNS_PER_HOUR: '5000',
        AUTOMATION_MERCARI_RUNS_PER_DAY: '0',
        SALE_CHECK_MIN_HOURS: '0.1',
        SALE_CHECK_MAX_HOURS: '6',
        AUTOMATION_STEP_TIMEOUT_MS: '20000',
        AUTOMATION_CALL_TIMEOUT_MS: '15000',
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AutomationConfigError);
    expect((error as AutomationConfigError).issues).toEqual([
      'AUTOMATION_CALL_TIMEOUT_MS must be at least AUTOMATION_STEP_TIMEOUT_MS',
      'AUTOMATION_MERCARI_RUNS_PER_DAY must be an integer from 1 to 1000',
      'AUTOMATION_DEPOP_PACE_MS must be min-max milliseconds, from 300 up to 60000',
      'AUTOMATION_DEPOP_SESSION_GAP_MS must be min-max milliseconds, from 2000 up to 600000',
      'AUTOMATION_DEPOP_RUNS_PER_HOUR must be an integer from 1 to 120',
      'SALE_CHECK_MIN_HOURS must be a number of hours from 1 to 72',
      'SALE_CHECK_MIN_HOURS, SALE_CHECK_DEFAULT_HOURS, and SALE_CHECK_MAX_HOURS must be in increasing order',
    ]);
  });

  it('points every automated marketplace at the fake site, local only', () => {
    const settings = loadAutomationSettings({ FAKE_AUTOMATION_SITE_URL: 'http://127.0.0.1:4400' });
    expect(settings.fakeSiteUrl).toBe('http://127.0.0.1:4400');
    expect(settings.profiles.mercari).toMatchObject({
      origins: ['http://127.0.0.1:4400'],
      cookieDomains: ['127.0.0.1'],
    });
    expect(() =>
      loadAutomationSettings({ FAKE_AUTOMATION_SITE_URL: 'https://poshmark.com' }),
    ).toThrow('FAKE_AUTOMATION_SITE_URL');
  });
});
