/**
 * The server's TypeScript types allow only known enum values, even where the contract is
 * open (`anyOf: [KnownX, string]`) for the Swift client. The `@ts-expect-error` lines are
 * checked by `tsc --build`: each fails the type check if a typo starts to compile.
 */
import { describe, expect, it } from 'vitest';

import type { ErrorCode, Listing, ListingStatus, StatusDisplay } from './index.ts';
import { knownListingStatusValues } from './index.ts';

const active: ListingStatus = 'active';
// @ts-expect-error A misspelled status must not compile on the server.
const typo: ListingStatus = 'actve';
// @ts-expect-error A misspelled tone must not compile on the server.
const badTone: StatusDisplay = { tone: 'sucess', label: 'Active (confirmed by eBay)' };
// @ts-expect-error A marketplace the contract does not know must not compile.
const badMarketplace: Listing['marketplace'] = 'vinted';
// @ts-expect-error An error code the contract does not know must not compile.
const badCode: ErrorCode = 'code_added_later';

describe('server types', () => {
  it('match the known values of open enums', () => {
    expect(knownListingStatusValues).toContain(active);
    expect([typo, badTone, badMarketplace, badCode]).toHaveLength(4);
  });
});
