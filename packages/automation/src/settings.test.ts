import { describe, expect, it } from 'vitest';

import { DEPOP_PACING } from './depop/site.ts';
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
        alertAfterFailures: 2,
        overdueMs: 6 * HOUR,
      },
      fakeSiteUrl: undefined,
      fakePoshmarkUrl: undefined,
      fakeMercariSiteUrl: undefined,
      fakeDepopSiteUrl: undefined,
    });
    for (const profile of Object.values(settings.profiles)) {
      // Depop's own pace is quicker, still a person's (depop/site.ts).
      expect(profile.pacing).toEqual(
        profile.marketplace === 'depop' ? DEPOP_PACING : DEFAULT_PACING,
      );
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
      SALE_CHECK_ALERT_FAILURES: '3',
      SALE_CHECK_OVERDUE_HOURS: '12',
    });
    expect(settings.profiles.poshmark.pacing.actionDelayMs).toEqual([1500, 4000]);
    expect(settings.profiles.poshmark.pacing.sessionGapMs).toEqual([10_000, 30_000]);
    expect(settings.profiles.poshmark.limits).toEqual({ runsPerHour: 10, runsPerDay: 200 });
    expect(settings.profiles.mercari.limits).toEqual({ runsPerHour: 30, runsPerDay: 50 });
    expect(settings.profiles.depop.pacing).toEqual(DEPOP_PACING);
    expect(settings.saleChecks).toMatchObject({
      defaultIntervalMs: 8 * HOUR,
      minIntervalMs: 1.5 * HOUR,
      alertAfterFailures: 3,
      overdueMs: 12 * HOUR,
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
        SALE_CHECK_ALERT_FAILURES: '0',
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
      'SALE_CHECK_ALERT_FAILURES must be an integer from 1 to 10',
      'SALE_CHECK_MIN_HOURS, SALE_CHECK_DEFAULT_HOURS, and SALE_CHECK_MAX_HOURS must be in increasing order',
    ]);
  });

  it('keeps the marketplaces that refuse the cloud off it, unless configured back', () => {
    const defaults = loadAutomationSettings({});
    expect(defaults.profiles.poshmark).toMatchObject({ runsOn: 'phone', cloudAllowed: false });
    expect(defaults.profiles.mercari).toMatchObject({ runsOn: 'phone', cloudAllowed: false });
    expect(defaults.profiles.depop).toMatchObject({ runsOn: 'phone', cloudAllowed: false });
    expect(defaults.profiles.ebay).toMatchObject({ runsOn: 'cloud', cloudAllowed: true });

    const reopened = loadAutomationSettings({
      AUTOMATION_DEPOP_CLOUD_ALLOWED: 'true',
      AUTOMATION_DEPOP_RUNS_ON: 'cloud',
    });
    expect(reopened.profiles.depop).toMatchObject({ runsOn: 'cloud', cloudAllowed: true });
  });

  it('refuses a cloud default for a marketplace the cloud is not allowed for', () => {
    expect(() =>
      loadAutomationSettings({
        AUTOMATION_MERCARI_RUNS_ON: 'cloud',
        AUTOMATION_EBAY_CLOUD_ALLOWED: 'yes',
      }),
    ).toThrow(
      expect.objectContaining({
        issues: [
          'AUTOMATION_MERCARI_RUNS_ON can be cloud only when AUTOMATION_MERCARI_CLOUD_ALLOWED is true',
          'AUTOMATION_EBAY_CLOUD_ALLOWED must be true or false',
        ],
      }),
    );
  });

  it('points every automated marketplace at the fake site, local only', () => {
    const settings = loadAutomationSettings({ FAKE_AUTOMATION_SITE_URL: 'http://127.0.0.1:4400' });
    expect(settings.fakeSiteUrl).toBe('http://127.0.0.1:4400');
    expect(settings.profiles.mercari).toMatchObject({
      origins: ['http://127.0.0.1:4400'],
      cookieDomains: ['127.0.0.1'],
      loginUrl: 'http://127.0.0.1:4400/login/',
    });
    expect(() =>
      loadAutomationSettings({ FAKE_AUTOMATION_SITE_URL: 'https://poshmark.com' }),
    ).toThrow('FAKE_AUTOMATION_SITE_URL');
  });

  it('points Poshmark at the fake Poshmark ahead of the fake site, local only', () => {
    const settings = loadAutomationSettings({
      FAKE_AUTOMATION_SITE_URL: 'http://127.0.0.1:4400',
      FAKE_POSHMARK_URL: 'http://127.0.0.1:4500',
    });
    expect(settings.fakePoshmarkUrl).toBe('http://127.0.0.1:4500');
    expect(settings.profiles.poshmark.origins).toEqual(['http://127.0.0.1:4500']);
    expect(settings.profiles.mercari.origins).toEqual(['http://127.0.0.1:4400']);
    // Without its own fake, Poshmark stands in on the fake site in development.
    expect(
      loadAutomationSettings({ FAKE_AUTOMATION_SITE_URL: 'http://127.0.0.1:4400' }).profiles
        .poshmark.origins,
    ).toEqual(['http://127.0.0.1:4400']);
    expect(() => loadAutomationSettings({ FAKE_POSHMARK_URL: 'https://poshmark.com' })).toThrow(
      'FAKE_POSHMARK_URL',
    );
  });

  it('points Mercari at the fake Mercari site, which wins over the fake site, local only', () => {
    const settings = loadAutomationSettings({
      FAKE_AUTOMATION_SITE_URL: 'http://127.0.0.1:4400',
      FAKE_MERCARI_SITE_URL: 'http://127.0.0.1:4600',
    });
    expect(settings.fakeMercariSiteUrl).toBe('http://127.0.0.1:4600');
    expect(settings.profiles.mercari.origins).toEqual(['http://127.0.0.1:4600']);
    expect(settings.profiles.poshmark.origins).toEqual(['http://127.0.0.1:4400']);
    expect(loadAutomationSettings({}).profiles.mercari.origins).toEqual([
      'https://www.mercari.com',
      'https://mercari.com',
    ]);
    expect(() =>
      loadAutomationSettings({ FAKE_MERCARI_SITE_URL: 'https://www.mercari.com' }),
    ).toThrow('FAKE_MERCARI_SITE_URL');
  });

  it('points Depop at the fake Depop site, which wins over the fake site, local only', () => {
    const settings = loadAutomationSettings({
      FAKE_AUTOMATION_SITE_URL: 'http://127.0.0.1:4400',
      FAKE_DEPOP_SITE_URL: 'http://127.0.0.1:4700',
    });
    expect(settings.fakeDepopSiteUrl).toBe('http://127.0.0.1:4700');
    expect(settings.profiles.depop.origins).toEqual(['http://127.0.0.1:4700']);
    expect(settings.profiles.mercari.origins).toEqual(['http://127.0.0.1:4400']);
    expect(loadAutomationSettings({}).profiles.depop).toMatchObject({
      origins: ['https://www.depop.com', 'https://depop.com'],
      cookieDomains: ['depop.com'],
    });
    expect(() => loadAutomationSettings({ FAKE_DEPOP_SITE_URL: 'https://www.depop.com' })).toThrow(
      'FAKE_DEPOP_SITE_URL',
    );
  });

  it('points eBay at the fake eBay site, which wins over the fake site, local only', () => {
    const settings = loadAutomationSettings({
      FAKE_AUTOMATION_SITE_URL: 'http://127.0.0.1:4400',
      FAKE_EBAY_SITE_URL: 'http://127.0.0.1:4800',
    });
    expect(settings.fakeEbaySiteUrl).toBe('http://127.0.0.1:4800');
    expect(settings.profiles.ebay).toMatchObject({
      origins: ['http://127.0.0.1:4800'],
      cookieDomains: ['127.0.0.1'],
      // eBay's own sign-in path, on the stand-in.
      loginUrl: 'http://127.0.0.1:4800/signin/',
    });
    expect(settings.profiles.depop.origins).toEqual(['http://127.0.0.1:4400']);
    expect(
      loadAutomationSettings({ FAKE_AUTOMATION_SITE_URL: 'http://127.0.0.1:4400' }).profiles.ebay
        .loginUrl,
    ).toBe('http://127.0.0.1:4400/signin/');
    expect(loadAutomationSettings({}).profiles.ebay).toMatchObject({
      origins: ['https://www.ebay.com', 'https://ebay.com', 'https://signin.ebay.com'],
      cookieDomains: ['ebay.com'],
      loginUrl: 'https://signin.ebay.com/signin/',
    });
    expect(() => loadAutomationSettings({ FAKE_EBAY_SITE_URL: 'https://www.ebay.com' })).toThrow(
      'FAKE_EBAY_SITE_URL',
    );
  });
});
