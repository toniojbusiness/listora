import { describe, expect, it } from 'vitest';

import { describeConnection } from './status-display.ts';
import type { ConnectionRow } from './store.ts';

const NOW = new Date('2026-10-24T12:00:00.000Z');
const DAY = 86_400_000;

function row(overrides: Partial<ConnectionRow> = {}): ConnectionRow {
  return {
    id: '0199a1f0-0000-7000-8000-00000000c001',
    account_id: '0199a1f0-0000-7000-8000-00000000a001',
    marketplace: 'ebay',
    mode: 'api',
    external_user_id: 'u1',
    display_name: 'listora_seller',
    token_ciphertext: Buffer.from('sealed'),
    access_expires_at: new Date(NOW.getTime() + 3_600_000),
    refresh_expires_at: new Date(NOW.getTime() + 400 * DAY),
    scopes: [],
    status: 'connected',
    last_ok_at: NOW,
    last_error: null,
    last_error_code: null,
    last_error_at: null,
    granted_at: new Date(NOW.getTime() - 10 * DAY),
    orders_polled_through: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

const describeEbay = (connection: ConnectionRow | undefined, canConnect = true) =>
  describeConnection({
    marketplace: 'ebay',
    row: connection,
    defaultMode: 'api',
    canConnect,
    now: NOW,
  });

describe('describeConnection', () => {
  it('offers to connect an API marketplace with no connection', () => {
    expect(describeEbay(undefined)).toEqual({
      marketplace: 'ebay',
      mode: 'api',
      status: 'not_connected',
      statusDisplay: {
        tone: 'neutral',
        label: 'Not connected',
        detail:
          'Connect your eBay account so Listora can list, update, and end your items there, and confirm every change with eBay.',
      },
      actions: ['connect'],
    });
  });

  it('says "coming soon" and offers nothing when this environment cannot connect', () => {
    expect(describeEbay(undefined, false)).toMatchObject({
      status: 'not_connected',
      statusDisplay: { label: 'Coming soon', detail: "Listora can't connect to eBay yet." },
      actions: [],
    });
  });

  it('shows assisted marketplaces as assisted, never as connected', () => {
    expect(
      describeConnection({
        marketplace: 'poshmark',
        row: undefined,
        defaultMode: 'assisted',
        canConnect: false,
        now: NOW,
      }),
    ).toMatchObject({
      mode: 'assisted',
      status: 'not_connected',
      statusDisplay: { tone: 'neutral', label: 'Assisted' },
      actions: [],
    });
  });

  it('shows a working connection as connected, with its seller and dates', () => {
    expect(describeEbay(row())).toMatchObject({
      status: 'connected',
      statusDisplay: {
        tone: 'success',
        label: 'Connected',
        detail: 'Signed in as listora_seller.',
      },
      actions: [],
      displayName: 'listora_seller',
      connectedAt: new Date(NOW.getTime() - 10 * DAY),
      grantExpiresAt: new Date(NOW.getTime() + 400 * DAY),
      lastOkAt: NOW,
    });
  });

  it('warns 30 days before the grant expires and offers to reconnect', () => {
    const expiresAt = new Date(NOW.getTime() + 30 * DAY);
    expect(describeEbay(row({ refresh_expires_at: expiresAt }))).toMatchObject({
      status: 'connected',
      statusDisplay: {
        tone: 'action_needed',
        label: 'Reconnect within 30 days',
        detail:
          "Listora's eBay access ends on November 23, 2026. Reconnect eBay before then to keep your listings in sync.",
      },
      actions: ['reconnect'],
    });
    expect(
      describeEbay(row({ refresh_expires_at: new Date(NOW.getTime() + 31 * DAY) })).statusDisplay
        .label,
    ).toBe('Connected');
    expect(
      describeEbay(row({ refresh_expires_at: new Date(NOW.getTime() + 3_600_000) })).statusDisplay
        .label,
    ).toBe('Reconnect within 1 day');
  });

  it('shows a degraded connection as a problem Listora keeps checking', () => {
    expect(
      describeEbay(
        row({
          status: 'degraded',
          last_error: 'eBay had a problem. Try again soon.',
          last_error_code: 'marketplace_error',
          last_error_at: NOW,
        }),
      ),
    ).toMatchObject({
      status: 'degraded',
      statusDisplay: {
        tone: 'checking',
        label: 'Connection problem',
        detail: 'eBay had a problem. Try again soon. Listora keeps checking.',
      },
      actions: ['reconnect'],
      lastIssue: { code: 'marketplace_error', message: 'eBay had a problem. Try again soon.' },
    });
  });

  it('asks to reconnect when reauthorization is required or the grant expired', () => {
    expect(
      describeEbay(
        row({
          status: 'reauth_required',
          last_error: 'eBay no longer accepts it.',
          last_error_code: 'grant_revoked',
          last_error_at: NOW,
        }),
      ),
    ).toMatchObject({
      status: 'reauth_required',
      statusDisplay: {
        tone: 'action_needed',
        label: 'Reconnect needed',
        detail: 'eBay no longer accepts it.',
      },
      actions: ['reconnect'],
    });
    expect(describeEbay(row({ refresh_expires_at: NOW }))).toMatchObject({
      status: 'reauth_required',
      statusDisplay: {
        label: 'Reconnect needed',
        detail: "Listora's eBay access expired. Reconnect eBay to keep your listings in sync.",
      },
    });
  });

  it('shows a revoked connection as access removed', () => {
    expect(
      describeEbay(
        row({
          status: 'revoked',
          token_ciphertext: null,
          last_error: 'You removed Listora.',
          last_error_code: 'revoked_by_seller',
          last_error_at: NOW,
        }),
      ),
    ).toMatchObject({
      status: 'revoked',
      statusDisplay: {
        tone: 'action_needed',
        label: 'Access removed',
        detail: 'You removed Listora.',
      },
      actions: ['reconnect'],
    });
  });
});
