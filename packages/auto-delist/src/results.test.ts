import { describe, expect, it } from 'vitest';

import type { ListingStatus, Marketplace, OperationStatus, SuccessEvidence } from '@listora/db';

import {
  delistResultState,
  describeDelistResult,
  listNames,
  summarizeDelistRun,
  type DelistOperationFacts,
  type DelistResultState,
} from './results.ts';

const op = (
  status: OperationStatus,
  extra: Partial<DelistOperationFacts> = {},
): DelistOperationFacts => ({
  kind: 'end',
  status,
  attempts: 0,
  errorMessage: null,
  successEvidence: null,
  ...extra,
});

const labelOf = (
  marketplace: Marketplace,
  operation: DelistOperationFacts,
  listingStatus: ListingStatus = 'active',
) => describeDelistResult({ marketplace, listingStatus, operation });

describe('delist results', () => {
  it.each<[OperationStatus, SuccessEvidence | null, DelistResultState]>([
    ['queued', null, 'pending'],
    ['running', null, 'pending'],
    ['retrying', null, 'pending'],
    ['verifying', null, 'verifying'],
    ['needs_user_action', null, 'needs_user_action'],
    ['failed', null, 'failed'],
    ['canceled', null, 'canceled'],
    ['succeeded', 'read_back', 'delisted'],
    ['succeeded', 'user_confirmation', 'user_confirmed'],
    // The database refuses this; it is never shown as done.
    ['succeeded', null, 'verifying'],
  ])('%s with %s evidence is %s', (status, successEvidence, state) => {
    expect(delistResultState({ status, successEvidence })).toBe(state);
  });

  it('labels each state honestly', () => {
    expect(labelOf('ebay', op('succeeded', { successEvidence: 'read_back' }), 'ended')).toEqual({
      tone: 'success',
      label: 'Delisted (confirmed by eBay)',
    });
    expect(
      labelOf(
        'depop',
        op('succeeded', { kind: 'mark_sold', successEvidence: 'read_back' }),
        'sold',
      ),
    ).toEqual({ tone: 'success', label: 'Marked sold (confirmed by Depop)' });
    expect(
      labelOf('poshmark', op('succeeded', { successEvidence: 'user_confirmation' }), 'ended'),
    ).toEqual({
      tone: 'success',
      label: 'Done (you confirmed)',
      detail: 'You delisted it on Poshmark.',
    });
    expect(
      labelOf('depop', op('retrying', { attempts: 2, errorMessage: 'Depop is busy.' })),
    ).toEqual({ tone: 'in_progress', label: 'Delisting...' });
    expect(labelOf('depop', op('verifying'))).toMatchObject({
      tone: 'checking',
      label: 'Checking...',
    });
    expect(labelOf('mercari', op('needs_user_action'))).toEqual({
      tone: 'action_needed',
      label: 'Action needed - delist on Mercari',
    });
    expect(labelOf('ebay', op('failed', { errorMessage: 'eBay refused.' }))).toEqual({
      tone: 'failed',
      label: 'Delist failed - Retry',
      detail: 'eBay refused.',
    });
    expect(labelOf('ebay', op('canceled'))).toMatchObject({
      tone: 'action_needed',
      label: 'Delist canceled',
    });
  });

  it('never says an assisted marketplace confirmed anything', () => {
    for (const status of ['queued', 'needs_user_action', 'failed', 'canceled'] as const) {
      expect(labelOf('poshmark', op(status)).label).not.toContain('confirmed by');
    }
  });

  it('summarizes a run whose delists wait for the iPhone as waiting there', () => {
    const waiting = { phoneWait: { since: new Date(), running: false } };
    expect(
      summarizeDelistRun([
        { marketplace: 'depop', state: 'pending', operation: waiting },
        { marketplace: 'ebay', state: 'delisted' },
      ]),
    ).toEqual({
      status: 'in_progress',
      display: { tone: 'in_progress', label: 'Waiting on your iPhone to delist on Depop' },
    });
  });

  it('summarizes a run: completed only when every listing is delisted or confirmed', () => {
    const run = (...states: [Marketplace, DelistResultState][]) =>
      summarizeDelistRun(states.map(([marketplace, state]) => ({ marketplace, state })));
    expect(run()).toEqual({
      status: 'completed',
      display: { tone: 'neutral', label: 'Not listed anywhere else' },
    });
    expect(run(['ebay', 'delisted'], ['poshmark', 'user_confirmed'])).toEqual({
      status: 'completed',
      display: { tone: 'success', label: 'Delisted everywhere' },
    });
    expect(run(['ebay', 'delisted'], ['depop', 'verifying'])).toEqual({
      status: 'in_progress',
      display: { tone: 'in_progress', label: 'Delisting on Depop...' },
    });
    expect(
      run(
        ['depop', 'pending'],
        ['poshmark', 'needs_user_action'],
        ['mercari', 'needs_user_action'],
      ),
    ).toEqual({
      status: 'attention_needed',
      display: { tone: 'action_needed', label: 'Action needed - delist on Poshmark and Mercari' },
    });
    // A failure is the most urgent thing to show.
    expect(run(['poshmark', 'needs_user_action'], ['depop', 'failed'])).toEqual({
      status: 'attention_needed',
      display: { tone: 'failed', label: 'Delist failed on Depop - Retry' },
    });
    expect(run(['ebay', 'delisted'], ['depop', 'canceled'])).toMatchObject({
      status: 'attention_needed',
    });
  });

  it('lists marketplace names', () => {
    expect(listNames(['poshmark'])).toBe('Poshmark');
    expect(listNames(['poshmark', 'mercari', 'poshmark'])).toBe('Poshmark and Mercari');
    expect(listNames(['ebay', 'depop', 'mercari'])).toBe('eBay, Depop, and Mercari');
  });
});
