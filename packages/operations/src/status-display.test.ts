import { describe, expect, it } from 'vitest';

import {
  LISTING_STATUSES,
  MARKETPLACES,
  OPERATION_KINDS,
  OPERATION_STATUSES,
  SUCCESS_EVIDENCE,
} from '@listora/db';

import {
  describeListingStatus,
  describeOperation,
  relistMode,
  waitedFor,
  type ListingStatusInput,
} from './status-display.ts';

function operation(
  overrides: Partial<NonNullable<ListingStatusInput['operation']>>,
): NonNullable<ListingStatusInput['operation']> {
  return {
    kind: 'end',
    status: 'succeeded',
    attempts: 1,
    errorMessage: null,
    successEvidence: 'read_back',
    ...overrides,
  };
}

describe('describeListingStatus', () => {
  it.each([
    [
      'a verified listing',
      { marketplace: 'ebay', listingStatus: 'active', operation: operation({ kind: 'create' }) },
      { tone: 'success', label: 'Active (confirmed by eBay)' },
    ],
    [
      'a verified delist',
      { marketplace: 'ebay', listingStatus: 'ended', operation: operation({}) },
      { tone: 'success', label: 'Delisted (confirmed by eBay)' },
    ],
    [
      'a listing marked sold after a sale elsewhere',
      {
        marketplace: 'depop',
        listingStatus: 'sold',
        operation: operation({ kind: 'mark_sold' }),
      },
      { tone: 'success', label: 'Marked sold (confirmed by Depop)' },
    ],
    [
      'a listing that sold there',
      { marketplace: 'ebay', listingStatus: 'sold', operation: operation({ kind: 'create' }) },
      { tone: 'success', label: 'Sold (confirmed by eBay)' },
    ],
    [
      'a delist waiting to retry',
      {
        marketplace: 'depop',
        listingStatus: 'active',
        operation: operation({
          status: 'retrying',
          attempts: 2,
          errorMessage: 'Depop is limiting requests right now.',
          successEvidence: null,
        }),
      },
      {
        tone: 'in_progress',
        label: 'Delisting... retry 2 of 6',
        detail: 'Depop is limiting requests right now.',
      },
    ],
    [
      'a failed delist',
      {
        marketplace: 'ebay',
        listingStatus: 'active',
        operation: operation({
          status: 'failed',
          errorMessage: 'eBay refused the change.',
          successEvidence: null,
        }),
      },
      { tone: 'failed', label: 'Delist failed - Retry', detail: 'eBay refused the change.' },
    ],
    [
      'a delist the marketplace refused, which can still be retried',
      {
        marketplace: 'poshmark',
        listingStatus: 'active',
        operation: operation({
          status: 'failed',
          errorCode: 'validation_failed',
          errorMessage: "Poshmark: This listing can't be changed right now.",
          successEvidence: null,
        }),
      },
      {
        tone: 'failed',
        label: 'Delist failed - Retry',
        detail: "Poshmark: This listing can't be changed right now.",
      },
    ],
    [
      'a listing whose content was refused, which only a fix gets past',
      {
        marketplace: 'ebay',
        listingStatus: 'draft',
        operation: operation({
          kind: 'create',
          status: 'failed',
          errorCode: 'validation_failed',
          errorMessage: 'eBay titles can be at most 80 characters. Fix it, then try again.',
          successEvidence: null,
        }),
      },
      {
        tone: 'failed',
        label: 'Publish failed',
        detail: 'eBay titles can be at most 80 characters. Fix it, then try again.',
      },
    ],
    [
      'an unknown outcome being checked',
      {
        marketplace: 'ebay',
        listingStatus: 'active',
        operation: operation({
          status: 'verifying',
          errorMessage: "eBay didn't answer in time.",
          successEvidence: null,
        }),
      },
      { tone: 'checking', label: 'Checking...', detail: "eBay didn't answer in time." },
    ],
    [
      'an assisted delist waiting for the user',
      {
        marketplace: 'poshmark',
        listingStatus: 'active',
        operation: operation({ status: 'needs_user_action', successEvidence: null }),
      },
      { tone: 'action_needed', label: 'Action needed - delist on Poshmark' },
    ],
    [
      'an assisted delist the user confirmed',
      {
        marketplace: 'poshmark',
        listingStatus: 'ended',
        operation: operation({ successEvidence: 'user_confirmation' }),
      },
      {
        tone: 'success',
        label: 'Done (you confirmed)',
        detail: 'You delisted it on Poshmark.',
      },
    ],
    [
      'an assisted listing the user confirmed',
      {
        marketplace: 'mercari',
        listingStatus: 'active',
        operation: operation({ kind: 'create', successEvidence: 'user_confirmation' }),
      },
      { tone: 'success', label: 'Done (you confirmed)', detail: 'You listed it on Mercari.' },
    ],
    [
      'a listing that was never published',
      { marketplace: 'ebay', listingStatus: 'draft', operation: null },
      { tone: 'neutral', label: 'Not listed' },
    ],
  ] as const)('shows %s', (_case, input, expected) => {
    expect(describeListingStatus(input)).toEqual(expected);
  });

  it('counts retries against the policy it is given', () => {
    expect(
      describeListingStatus({
        marketplace: 'ebay',
        listingStatus: 'active',
        operation: operation({ kind: 'price', status: 'retrying', successEvidence: null }),
        maxAttempts: 4,
      }).label,
    ).toBe('Updating price... retry 1 of 3');
  });

  it('says "confirmed by" only for a read-back, and "you confirmed" only for the user', () => {
    for (const marketplace of MARKETPLACES) {
      for (const listingStatus of LISTING_STATUSES) {
        for (const kind of OPERATION_KINDS) {
          for (const status of OPERATION_STATUSES) {
            for (const successEvidence of [...SUCCESS_EVIDENCE, null]) {
              const display = describeListingStatus({
                marketplace,
                listingStatus,
                operation: operation({ kind, status, successEvidence }),
              });
              const verified = status === 'succeeded' && successEvidence === 'read_back';
              const confirmedByUser =
                status === 'succeeded' && successEvidence === 'user_confirmation';
              const where = `${marketplace} ${listingStatus} ${kind} ${status} ${String(successEvidence)}`;
              expect(display.label.includes('confirmed by'), where).toBe(verified);
              expect(display.label.includes('you confirmed'), where).toBe(confirmedByUser);
              expect(display.tone === 'success', where).toBe(verified || confirmedByUser);
            }
          }
        }
      }
    }
  });

  it('never shows a listing without an operation as confirmed', () => {
    for (const listingStatus of LISTING_STATUSES) {
      const display = describeListingStatus({
        marketplace: 'ebay',
        listingStatus,
        operation: null,
      });
      expect(display.label).not.toMatch(/confirmed/);
      expect(display.tone).not.toBe('success');
    }
  });
});

describe('describeOperation', () => {
  it.each([
    ['create', 'Published (confirmed by eBay)'],
    ['price', 'Price changed (confirmed by eBay)'],
    ['end', 'Delisted (confirmed by eBay)'],
    ['relist', 'Relisted (confirmed by eBay)'],
  ] as const)('names what a confirmed %s did, whatever the listing is now', (kind, label) => {
    expect(describeOperation({ marketplace: 'ebay', operation: operation({ kind }) })).toEqual({
      tone: 'success',
      label,
    });
  });

  it('shows unfinished and failed operations as the listing does', () => {
    const failed = operation({ status: 'failed', errorMessage: 'eBay refused it.' });
    expect(describeOperation({ marketplace: 'ebay', operation: failed })).toEqual({
      tone: 'failed',
      label: 'Delist failed - Retry',
      detail: 'eBay refused it.',
    });
    expect(
      describeOperation({ marketplace: 'ebay', operation: operation({ status: 'canceled' }) }),
    ).toEqual({ tone: 'neutral', label: 'Canceled' });
  });

  it('says "confirmed by" only for a read-back, and "you confirmed" only for the user', () => {
    for (const kind of OPERATION_KINDS) {
      for (const status of OPERATION_STATUSES) {
        for (const successEvidence of [...SUCCESS_EVIDENCE, null]) {
          const display = describeOperation({
            marketplace: 'mercari',
            operation: operation({ kind, status, successEvidence }),
          });
          const verified = status === 'succeeded' && successEvidence === 'read_back';
          const confirmedByUser = status === 'succeeded' && successEvidence === 'user_confirmation';
          const where = `${kind} ${status} ${String(successEvidence)}`;
          expect(display.label.includes('confirmed by'), where).toBe(verified);
          expect(display.label.includes('you confirmed'), where).toBe(confirmedByUser);
          expect(display.tone === 'success', where).toBe(verified || confirmedByUser);
        }
      }
    }
  });

  it('says a step waits on the seller iPhone, and for how long, never that it is done', () => {
    const now = new Date('2026-10-26T12:00:00.000Z');
    const since = new Date(now.getTime() - 12 * 60_000);
    const waiting = (status: 'queued' | 'retrying' | 'verifying', running = false) =>
      describeListingStatus({
        marketplace: 'depop',
        listingStatus: 'active',
        operation: operation({ kind: 'end', status, phoneWait: { since, running } }),
        now,
      });
    expect(waiting('queued')).toEqual({
      tone: 'in_progress',
      label: 'Delisting... waiting on your iPhone (12 min)',
      detail: 'Open Listora on your iPhone to finish this on Depop. It has waited 12 min.',
    });
    expect(waiting('verifying').label).toBe('Checking... waiting on your iPhone (12 min)');
    expect(waiting('retrying', true)).toEqual({
      tone: 'in_progress',
      label: 'Delisting on your iPhone...',
    });
    // A settled operation is shown as it is, whatever waited before.
    expect(
      describeListingStatus({
        marketplace: 'depop',
        listingStatus: 'ended',
        operation: operation({
          kind: 'end',
          status: 'succeeded',
          successEvidence: 'read_back',
          phoneWait: { since, running: false },
        }),
        now,
      }).label,
    ).toBe('Delisted (confirmed by Depop)');
  });

  it('says a retry waits for its time, not for the iPhone, until it is due', () => {
    const now = new Date('2026-10-26T12:00:00.000Z');
    // Handed to the phone 12 minutes ago; its first attempt failed, and it is tried again later.
    const since = new Date(now.getTime() - 12 * 60_000);
    const retrying = (nextAttemptAt: Date) =>
      describeListingStatus({
        marketplace: 'depop',
        listingStatus: 'draft',
        operation: operation({
          kind: 'create',
          status: 'retrying',
          attempts: 1,
          errorMessage: 'Depop took too long to answer.',
          phoneWait: { since, running: false },
          nextAttemptAt,
        }),
        now,
        maxAttempts: 6,
      });
    // The app shows when (the time is the seller's), with Try now.
    expect(retrying(new Date(now.getTime() + 3 * 60_000))).toEqual({
      tone: 'in_progress',
      label: 'Publishing... retry 1 of 5',
      detail: 'Depop took too long to answer.',
    });
    // Due for 2 minutes and the phone hasn't taken it: it waits on the phone since it was due.
    expect(retrying(new Date(now.getTime() - 2 * 60_000)).label).toBe(
      'Publishing... waiting on your iPhone (2 min)',
    );
  });

  it('says whether a relist brings the listing back or posts a new one', () => {
    const relisting = (
      marketplace: 'mercari' | 'depop' | 'ebay',
      externalListingId: string | null,
    ) =>
      describeListingStatus({
        marketplace,
        listingStatus: 'ended',
        operation: operation({ kind: 'relist', status: 'running' }),
        relist: relistMode(marketplace, externalListingId, true),
      }).label;
    // Mercari activates the listing it ended; Poshmark puts it back for sale.
    expect(relisting('mercari', 'm123456789')).toBe('Reactivating...');
    // A Depop relist posts a new listing, and so does one of a listing the marketplace removed.
    expect(relisting('depop', 'old-slug')).toBe('Relisting (new listing)...');
    expect(relisting('mercari', null)).toBe('Relisting (new listing)...');
    // eBay relists under a new id of its own.
    expect(relisting('ebay', '110012345678')).toBe('Relisting...');
  });

  it('writes how long something waited in plain words', () => {
    expect(waitedFor(20_000)).toBe('less than a minute');
    expect(waitedFor(59 * 60_000)).toBe('59 min');
    expect(waitedFor(2 * 3_600_000)).toBe('2 h');
    expect(waitedFor(3 * 3_600_000 + 5 * 60_000)).toBe('3 h 5 min');
    expect(waitedFor(26 * 3_600_000)).toBe('1 day');
    expect(waitedFor(80 * 3_600_000)).toBe('3 days');
  });
});
