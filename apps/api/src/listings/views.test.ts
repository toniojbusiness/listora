import { LISTING_STATUSES, MARKETPLACES, OPERATION_STATUSES } from '@listora/db';
import { createMarketplaceAdapters, loadEbayConfig } from '@listora/marketplaces';
import { describe, expect, it } from 'vitest';

import type { ListingRow, OperationRow } from './repository.ts';
import { actionsForState, listingStatusDisplay, listingView, type ListingState } from './views.ts';

/** The adapters the API runs with when eBay is configured (the fake eBay's hosts). */
const CONTEXT = {
  adapters: createMarketplaceAdapters({
    fakeMarketplaceUrl: undefined,
    ebay: loadEbayConfig({ EBAY_ENV: 'fake' }),
    depop: undefined,
  }),
};

const view = (listing: ListingRow, operation?: OperationRow) =>
  listingView({ row: listing, operation }, CONTEXT);

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
    aspects: [],
    condition: null,
    hashtags: [],
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
        expect(view(listing).verification?.method).toBe('user_confirmation');
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
        expect(view(listing).verification).toBeUndefined();
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
    expect(view(row()).variant).toBeUndefined();
    expect(
      view(row({ title: 'Levi 501', price_cents: 4500, category_ref: '11483' })).variant,
    ).toEqual({
      title: 'Levi 501',
      description: '',
      price: { amountCents: 4500, currency: 'USD' },
      categoryRef: '11483',
    });
  });

  it("shows the newest operation's truth: in progress, retrying, failed, confirmed", () => {
    const api = { connection_id: 'c', connection_mode: 'api' as const };
    expect(
      view(row({ ...api, status: 'draft' }), operation({ kind: 'create', status: 'queued' }))
        .statusDisplay,
    ).toEqual({ tone: 'in_progress', label: 'Publishing...' });
    expect(
      view(
        row({ ...api, status: 'active' }),
        operation({ kind: 'end', status: 'retrying', attempts: 2, error_message: 'eBay is busy.' }),
      ).statusDisplay,
    ).toEqual({ tone: 'in_progress', label: 'Delisting... retry 2 of 6', detail: 'eBay is busy.' });
    expect(
      view(
        row({ ...api, status: 'active' }),
        operation({
          kind: 'end',
          status: 'failed',
          error_code: 'x',
          error_message: 'eBay refused it.',
        }),
      ).statusDisplay,
    ).toEqual({ tone: 'failed', label: 'Delist failed - Retry', detail: 'eBay refused it.' });
    expect(
      view(
        row({ ...api, status: 'ended', last_verified_at: AT }),
        operation({ kind: 'end', status: 'succeeded', success_evidence: 'read_back' }),
      ).statusDisplay,
    ).toEqual({ tone: 'success', label: 'Delisted (confirmed by eBay)' });
  });

  it("offers actions only when no change is unfinished, by the listing's state", () => {
    const state = (status: ListingRow['status'], op?: Partial<OperationRow>): ListingState => ({
      row: row({ status }),
      operation: op === undefined ? undefined : operation(op),
    });
    expect(actionsForState(state('draft'))).toEqual(['publish']);
    // A publish that failed may have been applied: Retry it, never publish twice.
    expect(actionsForState(state('draft', { kind: 'create', status: 'failed' }))).toEqual([]);
    expect(actionsForState(state('active'))).toEqual(['change_price', 'revise', 'end', 'verify']);
    // A failed price change must never keep the seller from delisting.
    expect(actionsForState(state('active', { kind: 'price', status: 'failed' }))).toContain('end');
    expect(actionsForState(state('ended'))).toEqual(['relist', 'verify']);
    for (const status of OPERATION_STATUSES) {
      const unfinished = !['succeeded', 'failed', 'canceled'].includes(status);
      const actions = actionsForState(state('active', { kind: 'end', status }));
      expect(actions.length === 0, status).toBe(unfinished);
    }
  });

  it('offers API actions under an API connection, and none for an assisted listing yet', () => {
    const ebay = view(row({ status: 'active', connection_id: 'c', connection_mode: 'api' }));
    expect(ebay.availableActions).toEqual([
      { action: 'change_price', mode: 'api' },
      { action: 'revise', mode: 'api' },
      { action: 'end', mode: 'api' },
      { action: 'verify', mode: 'api' },
    ]);
    expect(view(row({ marketplace: 'poshmark', status: 'active' })).availableActions).toEqual([]);
  });

  it('includes the newest operation with its own label', () => {
    const listing = view(
      row({ connection_id: 'c', connection_mode: 'api', status: 'active', last_verified_at: AT }),
      operation({ kind: 'create', status: 'succeeded', success_evidence: 'read_back' }),
    );
    expect(listing.latestOperation).toMatchObject({
      kind: 'create',
      status: 'succeeded',
      statusDisplay: { tone: 'success', label: 'Published (confirmed by eBay)' },
      verification: { method: 'marketplace_api' },
      attempt: 1,
      maxAttempts: 7,
    });
  });
});

function operation(overrides: Partial<OperationRow> = {}): OperationRow {
  return {
    id: '0199f0b4-0000-7000-8000-0000000000cc',
    account_id: '0199f0b4-0000-7000-8000-0000000000aa',
    listing_id: '0199f0b4-0000-7000-8000-000000000001',
    kind: 'create',
    idempotency_key: 'k',
    desired: { status: 'active' },
    status: 'queued',
    success_evidence: null,
    attempts: 1,
    next_attempt_at: null,
    error_code: null,
    error_message: null,
    origin: 'user',
    delist_run_id: null,
    created_at: AT,
    updated_at: AT,
    content: null,
    ...overrides,
  };
}
