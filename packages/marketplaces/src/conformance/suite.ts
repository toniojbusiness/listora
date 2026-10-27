/**
 * The shared adapter conformance suite (docs/features/marketplaces.md). Every adapter passes
 * it against its own fake marketplace before the engine may use it: call
 * `describeAdapterConformance` from the adapter's test file, once per connection mode it serves.
 *
 * The suite branches on capability flags, like the engine: kinds whose mode is `api` or
 * `automation` (read-back kinds) are checked against the marketplace (create, price and detail
 * updates, end, relist, mark sold, read-back with freshness, not-found classification, error
 * mapping, rate limiting, health), and kinds whose mode is `assisted` are checked to become user
 * tasks that never touch the marketplace and can never be confirmed by a read. An automated kind
 * whose session the marketplace rejects falls back to the same user task, never to a failure
 * the user can only retry. Every adapter's payload builder and validation are pinned by
 * golden files in its `__golden__` directory (rewrite them with `vitest -u` after a deliberate
 * change, and review the diff).
 *
 * Test-only: imported by adapters' `*.test.ts` files, in this package and others (as
 * `@listora/marketplaces/conformance`), never by runtime code.
 */
import { afterAll, afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { OPERATION_KINDS, type OperationKind } from '@listora/db';
import { assertNever } from '@listora/shared';

import {
  MARKETPLACE_NAMES,
  type AdapterContext,
  type ConnectionRef,
  type DesiredListingState,
  type ListingRef,
  type MarketplaceAdapter,
  type OperationRequest,
  type Outcome,
  type RemoteListingState,
  type WriteOperationKind,
} from '../adapter.ts';
import { checkCapabilities, operationMode, readBackState } from '../capabilities.ts';
import {
  desiredStateForContent,
  isContentKind,
  photosInOrder,
  type ContentKind,
  type ListingContent,
} from '../content.ts';
import {
  sampleListingContent as baseSampleContent,
  type SampleContentOverrides,
} from '../testing.ts';

/** Marketplace requests the suite can make fail. */
export type ConformanceAction =
  'create' | 'update' | 'end' | 'relist' | 'mark_sold' | 'read' | 'health';

/** The failure modes every fake marketplace must be able to produce. */
export type ConformanceFailure =
  /** 429, optionally with `Retry-After`; nothing applied. */
  | { type: 'rate_limited'; retryAfterSeconds?: number }
  /** 5xx; with `afterApply`, the change was applied before the error. */
  | { type: 'server_error'; afterApply: boolean }
  /** A validation error; nothing applied. */
  | { type: 'reject'; message: string }
  /** The seller's access is invalid or expired; nothing applied. */
  | { type: 'unauthorized' }
  /** The change is applied, and the answer comes only after the adapter's own timeout. */
  | { type: 'timeout_after_send' };

/** Controls an adapter's fake marketplace for the suite. */
export interface ConformanceMarketplace {
  /** The next `action` request fails this way. */
  failNext(action: ConformanceAction, failure: ConformanceFailure): void;
  /** The next read serves a listing as it was before its latest change. */
  serveStaleRead(): void;
  /**
   * Drops a listing, so the marketplace answers that it no longer exists. Omit it when the
   * marketplace never says so; the suite then checks that no absence is authoritative.
   */
  remove?(externalListingId: string): void;
  /**
   * How many listings the marketplace holds for the seller SKU a request for this listing sends
   * (its external SKU, or the id Listora named the listing with).
   */
  countListings(listing: ListingRef): number;
  /** Clears every pending failure. */
  reset(): void;
}

export interface AdapterConformanceOptions {
  /** Names the suite in the test report. */
  name: string;
  adapter: MarketplaceAdapter;
  /** The connection every call runs under; capabilities follow it. */
  connection: ConnectionRef | null;
  /** Absolute directory of this adapter's golden files for this connection mode. */
  goldenDir: string;
  /**
   * Changes to the sample listing for this marketplace (Depop: an item in a category its
   * taxonomy maps), applied under every change a check makes.
   */
  content?: SampleContentOverrides;
  /** Required when any capability is `api` or `automation`. */
  marketplace?: ConformanceMarketplace;
  /**
   * The same adapter pointed at an address where nothing listens. Required with `api` or
   * `automation`.
   */
  unreachable?: MarketplaceAdapter;
  /** Runs after the suite (for example to stop the fake marketplace). */
  teardown?: () => Promise<void>;
}

const WRITE_KINDS = OPERATION_KINDS.filter((kind): kind is WriteOperationKind => kind !== 'verify');

const TASK_KINDS = {
  create: 'list_manually',
  relist: 'list_manually',
  revise: 'edit_manually',
  price: 'edit_manually',
  end: 'delist_manually',
  mark_sold: 'delist_manually',
} as const satisfies Record<WriteOperationKind, string>;

let sequence = 0;
/** Every id an adapter that names its listings gave out in this run, as the engine keeps them. */
const namedIds: string[] = [];

export function describeAdapterConformance(options: AdapterConformanceOptions): void {
  const { adapter, connection } = options;
  const capabilities = adapter.capabilities(connection);
  const modeOf = (kind: OperationKind) => operationMode(capabilities, kind);
  const readsBack = (kind: OperationKind): boolean => {
    const mode = modeOf(kind);
    return mode === 'api' || mode === 'automation';
  };
  const usesReadBack = OPERATION_KINDS.some(readsBack);
  const name = MARKETPLACE_NAMES[adapter.id];
  const golden = (file: string): string => `${options.goldenDir.replace(/\/+$/, '')}/${file}`;
  /** What a read-back of this desired state must show (no title where listings have none). */
  const shown = (desired: DesiredListingState) => readBackState(desired, capabilities);

  function sampleListingContent(overrides: SampleContentOverrides = {}): ListingContent {
    const base = options.content ?? {};
    return baseSampleContent({
      item: { ...base.item, ...overrides.item },
      variant: { ...base.variant, ...overrides.variant },
    });
  }

  const ctx = (): AdapterContext => ({ signal: new AbortController().signal, connection });

  function newRef(): ListingRef {
    sequence += 1;
    const id = `conformance-${String(process.pid)}-${String(sequence)}`;
    return { listingId: id, externalListingId: null, externalSku: `SKU-${id}`, externalUrl: null };
  }

  /**
   * One attempt of an operation. A create or relist on a marketplace whose listings Listora
   * names gets its new listing's id first, as the engine assigns it before sending: the request's
   * `listing` carries it.
   */
  function request(
    kind: WriteOperationKind,
    listing: ListingRef,
    change: { content?: ListingContent; desired?: DesiredListingState } = {},
  ): OperationRequest {
    const content = change.content ?? sampleListingContent();
    const named =
      (kind === 'create' && listing.externalListingId === null) ||
      (kind === 'relist' && listing.externalListingId !== null)
        ? adapter.newListingId?.(content.item, namedIds, connection)
        : undefined;
    if (named !== undefined && named !== null) namedIds.push(named);
    const target =
      named === undefined || named === null ? listing : { ...listing, externalListingId: named };
    const base = {
      operationId: `op-${listing.listingId}-${kind}`,
      kind,
      idempotencyKey: `key-${listing.listingId}-${kind}`,
      attempt: 1,
      listing: target,
    };
    if (!isContentKind(kind))
      return { ...base, desired: change.desired ?? desiredFor(kind), payload: null };
    return {
      ...base,
      desired: change.desired ?? desiredStateForContent(kind, content),
      payload: adapter.buildPayload(content.item, content.variant, connection),
    };
  }

  describe(`${options.name}: adapter conformance`, () => {
    afterAll(async () => {
      await options.teardown?.();
    });

    it('declares capabilities the engine can rely on', () => {
      expect(checkCapabilities(capabilities)).toEqual([]);
      expect(adapter.capabilities(connection)).toEqual(capabilities);
      if (usesReadBack) {
        expect(options.marketplace, 'read-back kinds need a fake marketplace').toBeDefined();
        expect(options.unreachable, 'read-back kinds need an unreachable adapter').toBeDefined();
      }
    });

    it('builds payloads purely and pins them in a golden file', async () => {
      const content = deepFreeze(sampleListingContent());
      const payload = adapter.buildPayload(content.item, content.variant, connection);
      expect(adapter.buildPayload(content.item, content.variant, connection)).toEqual(payload);
      expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
      await expect(json(payload)).toMatchFileSnapshot(golden('payload.json'));
    });

    it('validates payloads against the marketplace rules, pinned in a golden file', async () => {
      const issuesFor = (content: ListingContent) =>
        adapter.validate(
          adapter.buildPayload(content.item, content.variant, connection),
          connection,
        );
      expect(issuesFor(sampleListingContent())).toEqual([]);

      const cases = {
        withoutPhotos: issuesFor(sampleListingContent({ item: { photos: [] } })),
        freeOfCharge: issuesFor(
          sampleListingContent({ variant: { price: { amountCents: 0, currency: 'USD' } } }),
        ),
        longestTitle: issuesFor(sampleListingContent({ variant: { title: 'x'.repeat(200) } })),
      };
      expect(cases.withoutPhotos.map((issue) => issue.field)).toContain('item.photos');
      expect(cases.freeOfCharge.map((issue) => issue.field)).toContain('variant.price');
      for (const issue of Object.values(cases).flat()) {
        expect(issue.message).toContain(name);
        expect(issue.code).toMatch(/^[a-z_]+$/);
      }
      await expect(json(cases)).toMatchFileSnapshot(golden('validation.json'));
    });

    it('checks the connection without throwing', async () => {
      const health = await adapter.healthCheck(ctx());
      expect(health).toEqual({ status: 'ok' });
    });

    const unsupported = WRITE_KINDS.filter((kind) => modeOf(kind) === 'unsupported');
    if (unsupported.length > 0) {
      it('refuses kinds it does not support', async () => {
        for (const kind of unsupported) {
          const outcome = await adapter.execute(request(kind, newRef()), ctx());
          expect(outcome, kind).toMatchObject({ type: 'rejected' });
        }
      });
    }

    const assisted = WRITE_KINDS.filter((kind) => modeOf(kind) === 'assisted');
    if (assisted.length > 0) describeAssistedKinds(assisted);
    if (usesReadBack) describeReadBackKinds();
  });

  function describeAssistedKinds(assisted: readonly WriteOperationKind[]): void {
    describe('assisted kinds', () => {
      let fetchSpy: MockInstance<typeof fetch> | undefined;

      afterEach(() => {
        if (fetchSpy === undefined) return;
        expect(fetchSpy, 'assisted adapters never contact the marketplace').not.toHaveBeenCalled();
        fetchSpy.mockRestore();
        fetchSpy = undefined;
      });

      function blockNetwork(): void {
        fetchSpy = vi
          .spyOn(globalThis, 'fetch')
          .mockRejectedValue(new Error('assisted adapters never contact the marketplace'));
      }

      it('turns each step into a user task with a deep link and copy-assist', async () => {
        blockNetwork();
        const content = sampleListingContent();
        const tasks: Record<string, unknown> = {};
        for (const kind of assisted) {
          const op = request(kind, newRef(), { content });
          const outcome = await adapter.execute(op, ctx());
          if (outcome.type !== 'pendingUser') {
            throw new Error(`${kind}: ${JSON.stringify(outcome)}`);
          }
          const { task } = outcome;
          expect(task.kind, kind).toBe(TASK_KINDS[kind]);
          expect(task.deepLink, kind).toMatch(/^https:\/\//);
          expect(task.payload['action'], kind).toBe(kind);
          if (isContentKind(kind)) {
            expect(task.payload['copyAssist'], kind).toEqual({
              title: content.variant.title,
              description: content.variant.description,
              price: content.variant.price,
              photos: photosInOrder(content.item).map(({ photoId, url }) => ({ photoId, url })),
            });
          }
          if (kind === 'price') {
            expect(task.payload['copyAssist'], kind).toEqual({
              price: { amountCents: op.desired.priceCents, currency: 'USD' },
            });
          }
          // An interrupted step runs again; it must ask for exactly the same task.
          expect(await adapter.execute(op, ctx()), kind).toEqual(outcome);
          tasks[kind] = task;
        }
        await expect(json(tasks)).toMatchFileSnapshot(golden('tasks.json'));
      });

      it('links changes only to a listing page on the marketplace itself', async () => {
        blockNetwork();
        const changes = assisted.filter((kind) => kind !== 'create' && kind !== 'relist');
        for (const kind of changes) {
          const foreign = { ...newRef(), externalUrl: 'https://phishing.example/listing/1' };
          const outcome = await adapter.execute(request(kind, foreign), ctx());
          expect(outcome.type === 'pendingUser' && outcome.task.deepLink, kind).not.toContain(
            'phishing.example',
          );
        }
      });

      it('never confirms an assisted step itself, and never reads the marketplace', async () => {
        blockNetwork();
        for (const kind of assisted) {
          const outcome = await adapter.execute(request(kind, newRef()), ctx());
          expect(['pendingUser', 'rejected', 'transient'], kind).toContain(outcome.type);
        }
        if (!usesReadBack) {
          expect(capabilities.verifyRead).toBe('user_confirm');
          await expect(adapter.readListing(newRef(), ctx())).rejects.toThrow();
        }
      });
    });
  }

  function describeReadBackKinds(): void {
    describe('read-back kinds', () => {
      const market = (): ConformanceMarketplace => {
        if (options.marketplace === undefined) throw new Error('no conformance marketplace');
        return options.marketplace;
      };
      const offline = (): MarketplaceAdapter => {
        if (options.unreachable === undefined) throw new Error('no unreachable adapter');
        return options.unreachable;
      };
      const isApi = readsBack;

      afterEach(() => {
        market().reset();
      });

      /** Creates a listing; `sent` is the listing as the create addressed it. */
      async function create(ref = newRef(), content = sampleListingContent()) {
        const op = request('create', ref, { content });
        const outcome = await adapter.execute(op, ctx());
        expect(outcome).toMatchObject({ type: 'confirmed' });
        const learned = outcome.type === 'confirmed' ? outcome.externalListingId : undefined;
        const remote = await adapter.readListing(op.listing, ctx());
        const externalListingId = learned ?? (remote.found ? remote.externalListingId : null);
        expect(externalListingId).toEqual(expect.any(String));
        return { ref: { ...op.listing, externalListingId }, sent: op.listing, outcome, content };
      }

      async function read(ref: ListingRef): Promise<Extract<RemoteListingState, { found: true }>> {
        const remote = await adapter.readListing(ref, ctx());
        if (!remote.found) throw new Error(`listing ${JSON.stringify(ref)} not found`);
        if (capabilities.readFreshness === 'revision') {
          expect(Number.isSafeInteger(remote.revision) && (remote.revision ?? -1) >= 0).toBe(true);
        } else {
          expect(remote.revision).toBeNull();
        }
        return remote;
      }

      it('creates with a read-back, the kind every error-mapping check below uses', () => {
        expect(isApi('create')).toBe(true);
      });

      it('creates a listing and reads it back by SKU and by id, with freshness', async () => {
        const { ref: listed, sent, outcome, content } = await create();
        const desired = shown(desiredStateForContent('create', content));
        const bySku = await read(sent);
        const byId = await read(listed);
        expect(byId).toMatchObject({ ...desired, externalListingId: listed.externalListingId });
        expect(byId).toEqual(bySku);
        if (outcome.type === 'confirmed' && outcome.revision !== undefined) {
          expect(capabilities.readFreshness).toBe('revision');
          expect(byId.revision).toBe(outcome.revision);
        }
      });

      it('applies a create sent again with the same idempotency key once', async () => {
        const op = request('create', newRef());
        expect(await adapter.execute(op, ctx())).toMatchObject({ type: 'confirmed' });
        expect(await adapter.execute({ ...op, attempt: 2 }, ctx())).toMatchObject({
          type: 'confirmed',
        });
        expect(market().countListings(op.listing)).toBe(1);
      });

      if (isApi('price')) {
        it('changes the price, and the read shows a newer revision', async () => {
          const { ref } = await create();
          const before = await read(ref);
          const outcome = await adapter.execute(
            request('price', ref, { desired: { priceCents: 3900, currency: 'USD' } }),
            ctx(),
          );
          expect(outcome).toMatchObject({ type: 'confirmed' });
          const after = await read(ref);
          expect(after).toMatchObject({ priceCents: 3900, status: 'active' });
          if (capabilities.readFreshness === 'revision') {
            expect(after.revision ?? 0).toBeGreaterThan(before.revision ?? 0);
          }
        });
      }

      if (isApi('price') && capabilities.readFreshness === 'revision') {
        it('marks a stale read with an older revision', async () => {
          const { ref } = await create();
          const priced = await adapter.execute(
            request('price', ref, { desired: { priceCents: 2500, currency: 'USD' } }),
            ctx(),
          );
          const current = await read(ref);
          if (priced.type === 'confirmed' && priced.revision !== undefined) {
            expect(current.revision).toBe(priced.revision);
          }
          market().serveStaleRead();
          const stale = await read(ref);
          expect(stale.revision ?? Infinity).toBeLessThan(current.revision ?? 0);
          expect(await read(ref)).toEqual(current);
        });
      }

      if (isApi('revise')) {
        it('replaces the listing details and reads them back', async () => {
          const { ref } = await create();
          const content = sampleListingContent({
            variant: { title: 'Updated title', description: 'Updated description with more detail.' },
          });
          const outcome = await adapter.execute(request('revise', ref, { content }), ctx());
          expect(outcome).toMatchObject({ type: 'confirmed' });
          expect(await read(ref)).toMatchObject(shown(desiredStateForContent('revise', content)));
        });
      }

      if (isApi('end')) {
        it('ends a listing, and ending it again still leaves the answer to a read-back', async () => {
          const { ref } = await create();
          const end = request('end', ref);
          expect(await adapter.execute(end, ctx())).toMatchObject({ type: 'confirmed' });
          expect(await read(ref)).toMatchObject({ status: 'ended' });
          expect(await adapter.execute({ ...end, attempt: 2 }, ctx())).toMatchObject({
            type: 'confirmed',
          });
          expect(await read(ref)).toMatchObject({ status: 'ended' });
        });
      }

      if (isApi('end') && isApi('relist')) {
        it('relists an ended listing', async () => {
          const { ref } = await create();
          expect(await adapter.execute(request('end', ref), ctx())).toMatchObject({
            type: 'confirmed',
          });
          const relist = request('relist', ref);
          const outcome = await adapter.execute(relist, ctx());
          expect(outcome).toMatchObject({ type: 'confirmed' });
          const relisted =
            outcome.type === 'confirmed' && outcome.externalListingId !== undefined
              ? { ...ref, externalListingId: outcome.externalListingId }
              : relist.listing;
          expect(await read(relisted)).toMatchObject({ status: 'active' });
        });
      }

      if (isApi('mark_sold')) {
        it('marks a listing sold', async () => {
          const { ref } = await create();
          expect(await adapter.execute(request('mark_sold', ref), ctx())).toMatchObject({
            type: 'confirmed',
          });
          expect(await read(ref)).toMatchObject({ status: 'sold' });
        });
      }

      it('refuses changes to a listing that is not on the marketplace yet', async () => {
        for (const kind of WRITE_KINDS) {
          if (kind === 'create' || !isApi(kind)) continue;
          const outcome = await adapter.execute(request(kind, newRef()), ctx());
          expect(outcome, kind).toMatchObject({ type: 'rejected' });
        }
      });

      it('says a listing is definitively gone only when the marketplace says so', async () => {
        expect(await adapter.readListing(newRef(), ctx())).toEqual({
          found: false,
          authoritative: false,
        });
        const unknownId = { ...newRef(), externalListingId: 'CONFORMANCE-MISSING-1' };
        expect(await adapter.readListing(unknownId, ctx())).toEqual({
          found: false,
          authoritative: false,
        });
        const marketplace = market();
        if (marketplace.remove !== undefined) {
          const { ref } = await create();
          marketplace.remove(ref.externalListingId ?? '');
          expect(await adapter.readListing(ref, ctx())).toEqual({
            found: false,
            authoritative: true,
          });
        }
      });

      describe('error mapping', () => {
        it('maps 429 to a transient outcome and honors Retry-After', async () => {
          market().failNext('create', { type: 'rate_limited', retryAfterSeconds: 3 });
          const op = request('create', newRef());
          const limited = await adapter.execute(op, ctx());
          expect(limited).toMatchObject({ type: 'transient', retryAfterMs: 3_000 });
          expectNamed(limited, name);
          expect(market().countListings(op.listing)).toBe(0);

          market().failNext('create', { type: 'rate_limited' });
          const plain = await adapter.execute(request('create', newRef()), ctx());
          expect(plain).toMatchObject({ type: 'transient' });
          expect(plain).not.toHaveProperty('retryAfterMs');
        });

        it('maps 5xx to a transient outcome, whether or not the change was applied', async () => {
          const before = request('create', newRef());
          market().failNext('create', { type: 'server_error', afterApply: false });
          expect(await adapter.execute(before, ctx())).toMatchObject({ type: 'transient' });
          expect(market().countListings(before.listing)).toBe(0);

          const after = request('create', newRef());
          market().failNext('create', { type: 'server_error', afterApply: true });
          expect(await adapter.execute(after, ctx())).toMatchObject({ type: 'transient' });
          expect(market().countListings(after.listing)).toBe(1);
        });

        it('maps a validation error to a rejected outcome with the reason', async () => {
          market().failNext('create', { type: 'reject', message: 'Size is required' });
          const outcome = await adapter.execute(request('create', newRef()), ctx());
          expect(outcome).toMatchObject({ type: 'rejected' });
          expect(outcome.type === 'rejected' && outcome.message).toContain('Size is required');
          expectNamed(outcome, name);
        });

        it('maps an expired authorization to a request to reconnect', async () => {
          const op = request('create', newRef());
          market().failNext('create', { type: 'unauthorized' });
          const outcome = await adapter.execute(op, ctx());
          if (modeOf('create') === 'automation') {
            // A rejected browser session is never retried: the user posts this one, and logs in
            // again for the next.
            expect(outcome).toMatchObject({
              type: 'pendingUser',
              task: { kind: TASK_KINDS.create, payload: { action: 'create' } },
            });
          } else {
            expect(outcome).toMatchObject({ type: 'rejected', code: 'reauth_required' });
          }
          expectNamed(outcome, name);
          expect(market().countListings(op.listing)).toBe(0);
        });

        it('maps a timeout after sending to an unknown outcome, never a failure', async () => {
          market().failNext('create', { type: 'timeout_after_send' });
          const op = request('create', newRef());
          const outcome = await adapter.execute(op, ctx());
          expect(outcome).toMatchObject({ type: 'unknown' });
          expectNamed(outcome, name);
          // The change landed, and a read-back finds it by SKU (or the id Listora named it with).
          expect(await adapter.readListing(op.listing, ctx())).toMatchObject({ found: true });
        });

        it('maps an unreachable marketplace to a transient outcome', async () => {
          expect(await offline().execute(request('create', newRef()), ctx())).toMatchObject({
            type: 'transient',
          });
          await expect(offline().readListing(newRef(), ctx())).rejects.toThrow();
        });

        it('throws for a read that fails, instead of reporting the listing missing', async () => {
          const failures: ConformanceFailure[] = [
            { type: 'server_error', afterApply: false },
            { type: 'rate_limited', retryAfterSeconds: 1 },
            { type: 'unauthorized' },
          ];
          for (const failure of failures) {
            market().failNext('read', failure);
            await expect(adapter.readListing(newRef(), ctx()), failure.type).rejects.toThrow();
          }
        });
      });

      it('reports connection health from one cheap call', async () => {
        market().failNext('health', { type: 'unauthorized' });
        expect(await adapter.healthCheck(ctx())).toMatchObject({ status: 'reauth_required' });
        market().failNext('health', { type: 'server_error', afterApply: false });
        expect(await adapter.healthCheck(ctx())).toMatchObject({ status: 'degraded' });
        market().failNext('health', { type: 'rate_limited' });
        expect(await adapter.healthCheck(ctx())).toMatchObject({ status: 'degraded' });
        expect(await offline().healthCheck(ctx())).toMatchObject({ status: 'degraded' });
        expect(await adapter.healthCheck(ctx())).toEqual({ status: 'ok' });
      });
    });
  }
}

/** The desired state of a kind that carries no content. */
function desiredFor(kind: Exclude<WriteOperationKind, ContentKind>): DesiredListingState {
  switch (kind) {
    case 'price':
      return { priceCents: 3900, currency: 'USD' };
    case 'end':
      return { status: 'ended' };
    case 'mark_sold':
      return { status: 'sold' };
    default:
      return assertNever(kind, 'operation kind');
  }
}

/** Failure messages are user-readable and name the marketplace. */
function expectNamed(outcome: Outcome, name: string): void {
  if (outcome.type === 'confirmed' || outcome.type === 'pendingUser') return;
  expect(outcome.message).toContain(name);
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
