import { LISTING_STATUSES, MARKETPLACES } from '@listora/db';
import { describe, expect, it } from 'vitest';

import type { ListingRow } from './repository.ts';
import { listingStatusDisplay, listingView } from './views.ts';

const AT = new Date('2026-10-24T12:00:00.000Z');

function row(overrides: Partial<ListingRow> = {}): ListingRow {
  return {
    id: '0199f0b4-0000-7000-8000-000000000001',
    account_id: '0199f0b4-0000-7000-8000-0000000000aa',
    item_id: '0199f0b4-0000-7000-8000-0000000000bb',
    marketplace: 'ebay',
    connection_id: null,
    connection_mode: null,
    status: 'active',
    external_listing_id: null,
    external_sku: null,
    external_url: null,
    title: null,
    description: null,
    currency: 'USD',
    price_cents: null,
    category_ref: null,
    aspects: {},
    listed_at: null,
    ended_at: null,
    last_verified_at: null,
    remote_snapshot: null,
    remote_revision: null,
    pending_external_listing_id: null,
    pending_remote_revision: null,
    desired_version: 0,
    applied_version: 0,
    created_at: AT,
    updated_at: AT,
    user_confirmed_at: null,
    ...overrides,
  };
}

describe('listing views', () => {
  it('says "confirmed by <marketplace>" only for an API listing with a read-back', () => {
    const api = { connection_id: 'c', connection_mode: 'api' as const };
    expect(listingStatusDisplay(row({ ...api, last_verified_at: AT }))).toEqual({
      tone: 'success',
      label: 'Active (confirmed by eBay)',
    });
    expect(
      listingStatusDisplay(row({ ...api, status: 'ended', last_verified_at: AT, ended_at: AT })),
    ).toEqual({ tone: 'success', label: 'Ended (confirmed by eBay)' });
    // A user confirmation is not a read-back.
    expect(listingStatusDisplay(row({ ...api, user_confirmed_at: AT }))).toEqual({
      tone: 'checking',
      label: 'Checking...',
    });
  });

  it('never says an assisted listing was confirmed by the marketplace', () => {
    for (const marketplace of MARKETPLACES) {
      for (const status of LISTING_STATUSES) {
        // Even a stray read-back time on an assisted listing is not the marketplace's word.
        const listing = row({
          marketplace,
          status,
          last_verified_at: AT,
          user_confirmed_at: AT,
        });
        const display = listingStatusDisplay(listing);
        expect(display.label).not.toMatch(/confirmed by/i);
        expect(listingView(listing).verification?.method).toBe('user_confirmation');
        if (display.tone === 'success') {
          expect(display.label).toBe('Active (you confirmed)');
        }
      }
    }
  });

  it('shows success only for a verified state', () => {
    for (const mode of ['api', 'assisted'] as const) {
      for (const status of LISTING_STATUSES) {
        const listing = row({
          status,
          ...(mode === 'api' ? { connection_id: 'c', connection_mode: 'api' } : {}),
        });
        expect(listingStatusDisplay(listing).tone).not.toBe('success');
        expect(listingView(listing).verification).toBeUndefined();
      }
    }
  });

  it('names the marketplace in sold and action-needed labels', () => {
    expect(listingStatusDisplay(row({ marketplace: 'depop', status: 'sold' })).label).toBe(
      'Sold on Depop',
    );
    expect(
      listingStatusDisplay(row({ marketplace: 'poshmark', status: 'needs_user_action' })),
    ).toEqual({ tone: 'action_needed', label: 'Action needed on Poshmark' });
  });

  it("shows Listora's variant only for a listing it wrote", () => {
    expect(listingView(row()).variant).toBeUndefined();
    expect(
      listingView(row({ title: 'Levi 501', price_cents: 4500, category_ref: '11483' })).variant,
    ).toEqual({
      title: 'Levi 501',
      description: '',
      price: { amountCents: 4500, currency: 'USD' },
      categoryRef: '11483',
    });
  });
});
