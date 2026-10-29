import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { AUTOMATED_MARKETPLACES, automationProfile } from '../profiles.ts';

/**
 * The iPhone app keeps only the origins and cookie domains it is built with
 * (`MarketplaceSites.compiled`, PhoneExecutionFeature), whatever a call names; they must be the
 * profiles' own, or the phone would refuse the marketplace's pages.
 */
describe("the app's built-in marketplace sites", () => {
  it("are each profile's origins, API origins, and cookie domains", async () => {
    const swift = await readFile(
      fileURLToPath(
        new URL(
          '../../../../apps/ios/Packages/Features/Sources/PhoneExecutionFeature/MarketplaceSites.swift',
          import.meta.url,
        ),
      ),
      'utf8',
    );
    const sites = compiledSites(swift);

    expect(Object.keys(sites).sort()).toEqual([...AUTOMATED_MARKETPLACES].sort());
    for (const marketplace of AUTOMATED_MARKETPLACES) {
      const profile = automationProfile(marketplace);
      expect(sites[marketplace], marketplace).toEqual({
        origins: [...profile.origins].sort(),
        apiOrigins: [...profile.apiOrigins].sort(),
        cookieDomains: [...profile.cookieDomains].sort(),
      });
    }
  });
});

type Site = Record<'origins' | 'apiOrigins' | 'cookieDomains', string[]>;

/** The `"<marketplace>": Site(origins: [...], apiOrigins: [...], cookieDomains: [...])` entries. */
function compiledSites(swift: string): Record<string, Site> {
  const sites: Record<string, Site> = {};
  const entry = /"(\w+)": Site\(([\s\S]*?)\n {8}\),/g;
  for (const [, marketplace = '', body = ''] of swift.matchAll(entry)) {
    const list = (name: keyof Site): string[] => {
      const match = new RegExp(`${name}: \\[([^\\]]*)\\]`).exec(body);
      return [...(match?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((found) => found[1] ?? '').sort();
    };
    sites[marketplace] = {
      origins: list('origins'),
      apiOrigins: list('apiOrigins'),
      cookieDomains: list('cookieDomains'),
    };
  }
  return sites;
}
