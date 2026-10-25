import { describe, expect, it } from 'vitest';

import { SALE_FORWARDING, summarizeConnectionHealth } from './health-summary.ts';
import type { ConnectionView } from './status-display.ts';

const NOW = new Date('2026-10-24T12:00:00.000Z');

function view(overrides: Partial<ConnectionView> & Pick<ConnectionView, 'marketplace'>) {
  return {
    mode: 'api',
    status: 'connected',
    statusDisplay: { tone: 'success', label: 'Connected' },
    actions: [],
    ...overrides,
  } satisfies ConnectionView;
}

const notLinked = (marketplace: 'depop' | 'poshmark' | 'mercari') =>
  view({
    marketplace,
    mode: 'assisted',
    status: 'not_connected',
    statusDisplay: { tone: 'neutral', label: 'Not linked' },
  });

const reconnect = view({
  marketplace: 'ebay',
  status: 'reauth_required',
  statusDisplay: {
    tone: 'action_needed',
    label: 'Reconnect needed',
    detail: 'eBay no longer accepts Listora. Reconnect eBay.',
  },
  actions: ['reconnect'],
  attention: 'reconnect',
});

const problem = view({
  marketplace: 'depop',
  status: 'degraded',
  statusDisplay: { tone: 'checking', label: 'Connection problem', detail: 'Depop is down.' },
  actions: ['check', 'reconnect'],
  attention: 'connection_problem',
});

describe('summarizeConnectionHealth', () => {
  it('needs no attention when everything works or is not linked, and says so', () => {
    const summary = summarizeConnectionHealth([
      view({ marketplace: 'ebay', lastCheckedAt: NOW }),
      notLinked('depop'),
      notLinked('poshmark'),
      notLinked('mercari'),
    ]);
    expect(summary).toEqual({
      needsAttention: false,
      attention: [],
      saleForwarding: SALE_FORWARDING,
      lastCheckedAt: NOW,
    });
    expect(summary.saleForwarding.statusDisplay.label).toBe('Set up when you add a domain');
  });

  it('shows one broken connection in the banner, in its own words', () => {
    expect(summarizeConnectionHealth([reconnect, notLinked('depop')])).toMatchObject({
      needsAttention: true,
      banner: {
        tone: 'action_needed',
        label: 'Reconnect eBay',
        detail: 'eBay no longer accepts Listora. Reconnect eBay.',
      },
      attention: [{ marketplace: 'ebay', reason: 'reconnect' }],
    });
  });

  it('names each reason in the banner', () => {
    const label = (overrides: Partial<ConnectionView>) =>
      summarizeConnectionHealth([view({ marketplace: 'ebay', ...overrides })]).banner?.label;
    expect(label({ attention: 'access_removed' })).toBe('Reconnect eBay');
    expect(label({ attention: 'expiring' })).toBe('Reconnect eBay soon');
    expect(label({ attention: 'connection_problem' })).toBe('eBay connection problem');
  });

  it('keeps a problem Listora keeps checking at the checking tone', () => {
    expect(summarizeConnectionHealth([problem]).banner).toEqual({
      tone: 'checking',
      label: 'Depop connection problem',
      detail: 'Depop is down.',
    });
  });

  it('counts several, what only the seller can fix first, and takes the latest check', () => {
    const expiring = view({
      marketplace: 'mercari',
      statusDisplay: { tone: 'action_needed', label: 'Reconnect within 3 days' },
      actions: ['reconnect'],
      attention: 'expiring',
      lastCheckedAt: new Date(NOW.getTime() - 1_000),
    });
    const summary = summarizeConnectionHealth([
      { ...problem, lastCheckedAt: NOW },
      expiring,
      { ...reconnect, lastCheckedAt: new Date(NOW.getTime() - 5_000) },
    ]);
    expect(summary.attention.map((entry) => entry.marketplace)).toEqual([
      'ebay',
      'mercari',
      'depop',
    ]);
    expect(summary.banner).toEqual({
      tone: 'action_needed',
      label: '3 marketplaces need attention',
      detail: 'eBay, Mercari, and Depop need you to look at their connections.',
    });
    expect(summary.lastCheckedAt).toEqual(NOW);
    expect(summarizeConnectionHealth([reconnect, problem]).banner?.detail).toBe(
      'eBay and Depop need you to look at their connections.',
    );
  });
});
