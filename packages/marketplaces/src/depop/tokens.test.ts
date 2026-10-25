/**
 * A seller's Depop tokens through rotation (tokens.ts), against the fake Depop: single-flight
 * refreshes, a refresh whose write is lost, another process refreshing first, and a revoked
 * grant.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ConnectionRef } from '../adapter.ts';
import { depopEndpoints } from './config.ts';
import { FAKE_DEPOP_CLIENT_ID, FAKE_DEPOP_CLIENT_SECRET } from './fake/constants.ts';
import { FakeDepop } from './fake/fake-depop.ts';
import { DepopOAuthClient, DepopReauthRequiredError, type DepopTokens } from './oauth.ts';
import { DepopSellerTokens, MemoryDepopTokenStore } from './tokens.ts';

const signal = new AbortController().signal;

describe('DepopSellerTokens against the fake Depop', () => {
  let fake: FakeDepop;
  let oauth: DepopOAuthClient;
  let store: MemoryDepopTokenStore;
  let connection: ConnectionRef;
  let sellerId: number;
  let sequence = 0;

  beforeAll(async () => {
    fake = await FakeDepop.start();
    const endpoints = depopEndpoints('fake', fake.url);
    oauth = new DepopOAuthClient({
      tokenUrl: endpoints.oauthToken,
      authorizeUrl: endpoints.authorize,
      clientId: FAKE_DEPOP_CLIENT_ID,
      clientSecret: FAKE_DEPOP_CLIENT_SECRET,
      timeoutMs: 2_000,
    });
  });

  afterAll(async () => {
    expect(fake.specViolations).toEqual([]);
    await fake.close();
  });

  beforeEach(() => {
    // Each check gets a seller of its own, connected with expired access.
    sequence += 1;
    connection = { id: `connection-${String(sequence)}`, mode: 'api', status: 'connected' };
    store = new MemoryDepopTokenStore();
    const seller = fake.addSeller();
    sellerId = seller.userId;
    store.connect(connection.id, seed(seller.refreshToken));
  });

  function seed(refreshToken: string): DepopTokens {
    return {
      accessToken: '',
      accessExpiresAt: 0,
      refreshToken,
      grantExpiresAt: Date.now() + 86_400_000,
    };
  }

  const tokens = (options: { refusalGraceMs?: number } = {}) =>
    new DepopSellerTokens({ oauth, store, refusalGraceMs: options.refusalGraceMs ?? 30 });

  /** Whether Depop accepts an access token. */
  async function works(accessToken: string): Promise<boolean> {
    const response = await fetch(`${fake.url}/api/v1/shop/`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    await response.arrayBuffer();
    return response.status === 200;
  }

  it('refreshes once for ten concurrent callers, and they all get the same working token', async () => {
    const source = tokens();
    const before = fake.tokenRequests;
    const results = await Promise.all(
      Array.from({ length: 10 }, () => source.accessToken(connection, signal)),
    );
    expect(fake.tokenRequests - before).toBe(1);
    expect(new Set(results).size).toBe(1);
    expect(await works(results[0] ?? '')).toBe(true);
    // The rotated refresh token is stored, and the next caller needs no refresh.
    expect((await store.load(connection.id))?.accessToken).toBe(results[0]);
    expect(await source.accessToken(connection, signal)).toBe(results[0]);
    expect(fake.tokenRequests - before).toBe(1);
  });

  it('keeps the shared refresh going when one caller gives up', async () => {
    const source = tokens();
    fake.inject({ action: 'token', fault: { type: 'timeout_after_send', delayMs: 200 } });
    const impatient = new AbortController();
    const first = source.accessToken(connection, impatient.signal);
    const second = source.accessToken(connection, signal);
    impatient.abort();
    await expect(first).rejects.toThrow('unavailable (aborted)');
    // The refresh still answers (late); the patient caller gets its token.
    expect(await works(await second)).toBe(true);
  });

  it('never strands the connection when storing a rotated token fails', async () => {
    const source = tokens();
    const stored = await store.load(connection.id);
    store.failWrites(1);
    const token = await source.accessToken(connection, signal);
    expect(await works(token)).toBe(true);
    // The store still has the used-up token; this process holds the new one.
    expect((await store.load(connection.id))?.refreshToken).toBe(stored?.refreshToken);

    // Another worker still reads the old token: Depop refuses it, and that worker marks the
    // connection for reconnecting...
    const other = new DepopSellerTokens({ oauth, store, refusalGraceMs: 30 });
    await expect(other.accessToken(connection, signal)).rejects.toBeInstanceOf(
      DepopReauthRequiredError,
    );
    expect(store.status(connection.id)).toBe('reauth_required');

    // ...until this process stores the new tokens on its next call, which clears the mark.
    fake.expireAccessTokens();
    source.forget(connection, token);
    const next = await source.accessToken(connection, signal);
    expect(await works(next)).toBe(true);
    expect(store.status(connection.id)).toBe('connected');
    expect((await store.load(connection.id))?.accessToken).toBe(next);
    // And the other worker now uses them too.
    expect(await other.accessToken(connection, signal)).toBe(next);
  });

  it('refreshes from the newest refresh token after a lost write, not the stored one', async () => {
    const source = tokens();
    store.failWrites(2);
    const first = await source.accessToken(connection, signal);
    fake.expireAccessTokens();
    source.forget(connection, first);
    // The second write fails too: the refresh used this process's newest token regardless.
    const second = await source.accessToken(connection, signal);
    expect(second).not.toBe(first);
    expect(await works(second)).toBe(true);
    expect(await source.accessToken(connection, signal)).toBe(second);
    expect((await store.load(connection.id))?.accessToken).toBe(second);
  });

  it("uses another process's tokens when it refreshed first", async () => {
    const mine = tokens();
    const theirs = tokens();
    // Both processes hold the same tokens; their access tokens expire.
    const old = await mine.accessToken(connection, signal);
    expect(await theirs.accessToken(connection, signal)).toBe(old);
    fake.expireAccessTokens();
    mine.forget(connection, old);
    theirs.forget(connection, old);
    // The other process refreshes first and stores the rotated tokens.
    const token = await theirs.accessToken(connection, signal);
    // Depop refuses this process's used-up refresh token; it takes the stored tokens instead.
    const before = fake.tokenRequests;
    expect(await mine.accessToken(connection, signal)).toBe(token);
    expect(fake.tokenRequests - before).toBe(1);
    expect(store.status(connection.id)).toBe('connected');
  });

  it('waits briefly for a racing refresh to be stored before calling the grant gone', async () => {
    const used = await store.load(connection.id);
    if (used === null) throw new Error('connected');
    // Another process refreshes the same token and takes 100 ms to store the result.
    const rotated = await oauth.refresh(used, signal);
    setTimeout(() => {
      void store.replace(connection.id, used.refreshToken, rotated);
    }, 100);
    const source = tokens({ refusalGraceMs: 600 });
    expect(await source.accessToken(connection, signal)).toBe(rotated.accessToken);
    expect(store.status(connection.id)).toBe('connected');
  });

  it('asks the seller to reconnect when the grant is revoked', async () => {
    const source = tokens();
    const token = await source.accessToken(connection, signal);
    fake.revokeSeller(sellerId);
    fake.expireAccessTokens();
    source.forget(connection, token);
    await expect(source.accessToken(connection, signal)).rejects.toBeInstanceOf(
      DepopReauthRequiredError,
    );
    expect(store.status(connection.id)).toBe('reauth_required');
  });

  it('refuses connections that are not api ones, and connections without tokens', async () => {
    const source = tokens();
    await expect(source.accessToken(null, signal)).rejects.toThrow('Connect Depop');
    await expect(
      source.accessToken({ id: connection.id, mode: 'assisted', status: 'connected' }, signal),
    ).rejects.toThrow('Connect Depop');
    await expect(
      source.accessToken({ id: 'never-connected', mode: 'api', status: 'connected' }, signal),
    ).rejects.toThrow('Connect Depop');
  });
});
