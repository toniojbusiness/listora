/**
 * The fake marketplace: a small HTTP server that behaves like a marketplace listing API, with
 * fault injection, for development and tests. It runs outside the worker (in the test process)
 * so its state survives a worker that is killed mid-operation, exactly like a real marketplace.
 *
 * One server hosts every marketplace id under its own path prefix (`/ebay/...`). The API:
 *
 *   POST  /:marketplace/listings              create (an `Idempotency-Key` header dedupes)
 *   GET   /:marketplace/listings?sku=...      find by seller SKU
 *   GET   /:marketplace/listings/:id          read
 *   PATCH /:marketplace/listings/:id          update title, description, price
 *   POST  /:marketplace/listings/:id/end      end (409 `already_ended` when it is not active)
 *   POST  /:marketplace/listings/:id/relist   relist an ended listing
 *   POST  /:marketplace/listings/:id/mark-sold
 *
 * Like eBay's `AddFixedPriceItem`, create is not idempotent by itself: sending it twice without
 * the same `Idempotency-Key` creates two listings, which is what the chaos tests look for.
 *
 * A listing removed with `remove` answers 410 Gone, like a marketplace that dropped it; a plain
 * 404 means only that the fake does not show the listing (yet, for a stale read).
 *
 * Every listing has a `revision` that starts at 1 and grows by one with every applied change; a
 * stale read serves the older revision along with the older state.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Marketplace } from '@listora/db';
import type { CurrencyCode } from '@listora/shared';

import { isMarketplace, type RemoteListingStatus } from '../adapter.ts';

export interface FakeListing {
  id: string;
  sku: string;
  status: RemoteListingStatus;
  title: string;
  description: string;
  priceCents: number;
  currency: CurrencyCode;
  url: string;
  revision: number;
}

export type FakeAction = 'create' | 'update' | 'end' | 'relist' | 'mark_sold' | 'read';

export type FakeFault =
  /** 429 with an optional `Retry-After`; nothing is applied. */
  | { type: 'rate_limited'; retryAfterSeconds?: number }
  /** A 5xx response; with `afterApply` the change is applied first (a gateway error). */
  | { type: 'server_error'; status?: number; afterApply?: boolean }
  /** 400 validation error; nothing is applied. */
  | { type: 'reject'; message?: string }
  /** The change is applied, then the answer comes after `delayMs` (after the client gave up). */
  | { type: 'timeout_after_send'; delayMs?: number }
  /** The request is held without an answer until the server closes (a crash mid-operation). */
  | { type: 'hang'; afterApply: boolean }
  /** Reads return the listing as it was before its latest change (eventual consistency). */
  | { type: 'stale_read' };

export interface FaultRule {
  action: FakeAction;
  fault: FakeFault;
  /** Only requests for this marketplace (default: any). */
  marketplace?: Marketplace;
  /** Only requests for this seller SKU (default: any). */
  sku?: string;
  /** How many matching requests get the fault (default 1; `Infinity` for every one). */
  times?: number;
}

/** Chooses a fault (or none) for a request that no rule matched; see `setChaos`. */
export type FaultPicker = (request: {
  marketplace: Marketplace;
  action: FakeAction;
  sku: string | null;
}) => FakeFault | undefined;

export interface FakeRequest {
  marketplace: Marketplace;
  action: FakeAction;
  sku: string | null;
  listingId: string | null;
  idempotencyKey: string | null;
  fault: FakeFault['type'] | null;
  /** Whether the request changed the listing. */
  applied: boolean;
  /** The status code sent, or `held` while a `hang` fault keeps the request open. */
  status: number | 'held';
}

interface StoredListing {
  current: FakeListing;
  /** The listing before its latest change; `null` when the latest change created it. */
  previous: FakeListing | null;
  idempotencyKey: string | null;
}

interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class FakeMarketplace {
  readonly #server: Server;
  readonly #listings = new Map<Marketplace, StoredListing[]>();
  readonly #removed = new Set<string>();
  readonly #faults: (FaultRule & { remaining: number })[] = [];
  readonly #requests: FakeRequest[] = [];
  readonly #waiters = new Set<() => void>();
  readonly #inFlight = new Map<string, number>();
  readonly #timers = new Set<NodeJS.Timeout>();
  #chaos: FaultPicker | undefined;
  #relistIssuesNewId = false;
  #maxInFlightPerSku = 0;
  #latencyMs = 0;
  #nextId = 1;
  #url = '';

  private constructor() {
    this.#server = createServer((request, response) => {
      this.#handle(request, response).catch((error: unknown) => {
        send(response, {
          status: 500,
          body: errorBody('fake_error', error instanceof Error ? error.message : String(error)),
        });
      });
    });
  }

  /** Starts a fake marketplace on 127.0.0.1, on `port` or else an ephemeral port. */
  static async start(port = 0): Promise<FakeMarketplace> {
    const fake = new FakeMarketplace();
    await new Promise<void>((resolve, reject) => {
      fake.#server.once('error', reject);
      fake.#server.listen(port, '127.0.0.1', () => {
        fake.#server.off('error', reject);
        resolve();
      });
    });
    fake.#url = `http://127.0.0.1:${String((fake.#server.address() as AddressInfo).port)}`;
    return fake;
  }

  /** Base URL for adapters (`FAKE_MARKETPLACE_URL`). */
  get url(): string {
    return this.#url;
  }

  /** Every request received so far, in order. */
  get requests(): readonly FakeRequest[] {
    return this.#requests;
  }

  /** The most requests for one SKU that were ever being processed at the same time. */
  get maxInFlightPerSku(): number {
    return this.#maxInFlightPerSku;
  }

  /** Adds a fault for upcoming requests. Rules are matched in the order they were added. */
  inject(rule: FaultRule): void {
    this.#faults.push({ ...rule, remaining: rule.times ?? 1 });
  }

  /** Removes every fault rule and the chaos picker. */
  clearFaults(): void {
    this.#faults.length = 0;
    this.#chaos = undefined;
  }

  /** Picks faults for requests that no rule matches, for randomized chaos runs. */
  setChaos(picker: FaultPicker | undefined): void {
    this.#chaos = picker;
  }

  /**
   * Relists under a new listing id, like eBay's `RelistItem`; the ended listing keeps its id.
   * Off by default (relisting keeps the id).
   */
  setRelistIssuesNewId(enabled: boolean): void {
    this.#relistIssuesNewId = enabled;
  }

  /** Delays every answer, so concurrent requests overlap. */
  setLatency(ms: number): void {
    this.#latencyMs = ms;
  }

  /** The listings of one marketplace, optionally only those with a seller SKU. */
  listings(marketplace: Marketplace, sku?: string): FakeListing[] {
    return (this.#listings.get(marketplace) ?? [])
      .filter((stored) => sku === undefined || stored.current.sku === sku)
      .map((stored) => ({ ...stored.current }));
  }

  /** Adds a listing directly, as if it had been created on the marketplace earlier. */
  seed(
    marketplace: Marketplace,
    listing: Omit<FakeListing, 'id' | 'url' | 'revision'>,
  ): FakeListing {
    const created = this.#create(marketplace, listing, null);
    created.previous = created.current;
    return { ...created.current };
  }

  /** Drops a listing, as eBay does with ended listings after a while; it answers 410 Gone. */
  remove(marketplace: Marketplace, id: string): void {
    this.#removed.add(`${marketplace}:${id}`);
    this.#listings.set(
      marketplace,
      this.#all(marketplace).filter((stored) => stored.current.id !== id),
    );
  }

  /** Resolves with the first request matching `predicate`, waiting for it if needed. */
  waitForRequest(
    predicate: (request: FakeRequest) => boolean,
    timeoutMs = 10_000,
  ): Promise<FakeRequest> {
    return new Promise((resolve, reject) => {
      const check = (): void => {
        const match = this.#requests.find(predicate);
        if (match === undefined) return;
        cleanup();
        resolve(match);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('timed out waiting for a fake marketplace request'));
      }, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        this.#waiters.delete(check);
      };
      this.#waiters.add(check);
      check();
    });
  }

  /** Stops the server, dropping held and delayed requests. */
  async close(): Promise<void> {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.#server.close(() => {
        resolve();
      });
    });
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://fake.invalid');
    const [marketplaceSegment = '', collection, id, verb, ...rest] = url.pathname
      .split('/')
      .filter(Boolean);
    const marketplace = isMarketplace(marketplaceSegment) ? marketplaceSegment : undefined;
    const route =
      marketplace === undefined || collection !== 'listings' || rest.length > 0
        ? undefined
        : resolveRoute(request.method ?? 'GET', id, verb);
    if (marketplace === undefined || route === undefined) {
      send(response, { status: 404, body: errorBody('not_found', 'No such endpoint') });
      return;
    }

    const body = await readBody(request);
    const idempotencyKey = headerValue(request, 'idempotency-key');
    const stored = id === undefined ? undefined : this.#find(marketplace, id);
    const sku =
      route === 'create'
        ? typeof body['sku'] === 'string'
          ? body['sku']
          : null
        : (stored?.current.sku ?? url.searchParams.get('sku'));
    const record: FakeRequest = {
      marketplace,
      action: route,
      sku,
      listingId: id ?? null,
      idempotencyKey,
      fault: null,
      applied: false,
      status: 'held',
    };
    const fault = this.#takeFault(marketplace, route, sku);
    record.fault = fault?.type ?? null;

    const flightKey = `${marketplace}:${sku ?? id ?? '?'}`;
    this.#enter(flightKey);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.#leave(flightKey);
    };
    response.on('close', release);

    if (this.#latencyMs > 0) await this.#sleep(this.#latencyMs);

    const apply = (): Reply => {
      try {
        const reply = this.#apply(marketplace, route, id, url, body, idempotencyKey, fault);
        record.applied = reply.status < 300 && route !== 'read';
        return reply;
      } catch (error) {
        if (error instanceof HttpError) {
          return { status: error.status, body: errorBody(error.code, error.message) };
        }
        throw error;
      }
    };

    const reply = (result: Reply): void => {
      record.status = result.status;
      send(response, result);
      release();
    };

    switch (fault?.type) {
      case 'rate_limited':
        this.#record(record);
        reply({
          status: 429,
          body: errorBody('rate_limited', 'Too many requests'),
          ...(fault.retryAfterSeconds === undefined
            ? {}
            : { headers: { 'retry-after': String(fault.retryAfterSeconds) } }),
        });
        return;
      case 'server_error': {
        if (fault.afterApply === true) apply();
        this.#record(record);
        reply({
          status: fault.status ?? 503,
          body: errorBody('server_error', 'Temporary server problem'),
        });
        return;
      }
      case 'reject':
        this.#record(record);
        reply({
          status: 400,
          body: errorBody('validation_failed', fault.message ?? 'The listing is invalid'),
        });
        return;
      case 'timeout_after_send': {
        const result = apply();
        this.#record(record);
        const timer = setTimeout(() => {
          this.#timers.delete(timer);
          reply(result);
        }, fault.delayMs ?? 60_000);
        this.#timers.add(timer);
        return;
      }
      case 'hang':
        if (fault.afterApply) apply();
        this.#record(record);
        return;
      case 'stale_read':
      case undefined: {
        const result = apply();
        this.#record(record);
        reply(result);
        return;
      }
    }
  }

  #apply(
    marketplace: Marketplace,
    route: FakeAction,
    id: string | undefined,
    url: URL,
    body: Record<string, unknown>,
    idempotencyKey: string | null,
    fault: FakeFault | undefined,
  ): Reply {
    if (route === 'create') {
      const duplicate =
        idempotencyKey === null
          ? undefined
          : this.#all(marketplace).find((stored) => stored.idempotencyKey === idempotencyKey);
      if (duplicate !== undefined) return { status: 200, body: { listing: duplicate.current } };
      const created = this.#create(marketplace, validateCreate(body), idempotencyKey);
      return { status: 201, body: { listing: created.current } };
    }

    if (route === 'read' && id === undefined) {
      const sku = url.searchParams.get('sku');
      if (sku === null) throw new HttpError(400, 'validation_failed', 'sku is required');
      const listings = this.#all(marketplace)
        .filter((stored) => stored.current.sku === sku)
        .map((stored) => (fault?.type === 'stale_read' ? stored.previous : stored.current))
        .filter((listing) => listing !== null);
      return { status: 200, body: { listings } };
    }

    const stored = id === undefined ? undefined : this.#find(marketplace, id);
    if (stored === undefined) {
      if (id !== undefined && this.#removed.has(`${marketplace}:${id}`)) {
        throw new HttpError(410, 'gone', 'The listing was removed');
      }
      throw new HttpError(404, 'not_found', 'Listing not found');
    }

    switch (route) {
      case 'read': {
        const listing = fault?.type === 'stale_read' ? stored.previous : stored.current;
        if (listing === null) throw new HttpError(404, 'not_found', 'Listing not found');
        return { status: 200, body: { listing } };
      }
      case 'update': {
        if (stored.current.status !== 'active') {
          throw new HttpError(409, 'not_active', 'Only active listings can be changed');
        }
        this.#change(stored, validateUpdate(body));
        return { status: 200, body: { listing: stored.current } };
      }
      case 'end':
        if (stored.current.status !== 'active') {
          throw new HttpError(409, 'already_ended', 'The listing is not active');
        }
        this.#change(stored, { status: 'ended' });
        return { status: 200, body: { listing: stored.current } };
      case 'relist': {
        if (stored.current.status !== 'ended') {
          throw new HttpError(409, 'not_ended', 'Only ended listings can be relisted');
        }
        if (this.#relistIssuesNewId) {
          const { sku, title, description, priceCents, currency } = stored.current;
          const relisted = this.#create(
            marketplace,
            { sku, status: 'active', title, description, priceCents, currency },
            null,
          );
          return { status: 200, body: { listing: relisted.current } };
        }
        this.#change(stored, { status: 'active' });
        return { status: 200, body: { listing: stored.current } };
      }
      case 'mark_sold':
        if (stored.current.status === 'sold') {
          throw new HttpError(409, 'already_sold', 'The listing is already sold');
        }
        this.#change(stored, { status: 'sold' });
        return { status: 200, body: { listing: stored.current } };
    }
  }

  #create(
    marketplace: Marketplace,
    fields: Omit<FakeListing, 'id' | 'url' | 'revision'>,
    idempotencyKey: string | null,
  ): StoredListing {
    const id = `${marketplace.toUpperCase()}-${String(this.#nextId++).padStart(6, '0')}`;
    const stored: StoredListing = {
      current: { ...fields, id, url: `${this.#url}/${marketplace}/listings/${id}`, revision: 1 },
      previous: null,
      idempotencyKey,
    };
    const listings = this.#listings.get(marketplace) ?? [];
    listings.push(stored);
    this.#listings.set(marketplace, listings);
    return stored;
  }

  #change(stored: StoredListing, changes: Partial<FakeListing>): void {
    stored.previous = { ...stored.current };
    stored.current = { ...stored.current, ...changes, revision: stored.current.revision + 1 };
  }

  #all(marketplace: Marketplace): StoredListing[] {
    return this.#listings.get(marketplace) ?? [];
  }

  #find(marketplace: Marketplace, id: string): StoredListing | undefined {
    return this.#all(marketplace).find((stored) => stored.current.id === id);
  }

  #takeFault(
    marketplace: Marketplace,
    action: FakeAction,
    sku: string | null,
  ): FakeFault | undefined {
    const rule = this.#faults.find(
      (candidate) =>
        candidate.remaining > 0 &&
        candidate.action === action &&
        (candidate.marketplace === undefined || candidate.marketplace === marketplace) &&
        (candidate.sku === undefined || candidate.sku === sku),
    );
    if (rule === undefined) return this.#chaos?.({ marketplace, action, sku });
    rule.remaining -= 1;
    return rule.fault;
  }

  #record(request: FakeRequest): void {
    this.#requests.push(request);
    for (const waiter of [...this.#waiters]) waiter();
  }

  #enter(key: string): void {
    const count = (this.#inFlight.get(key) ?? 0) + 1;
    this.#inFlight.set(key, count);
    this.#maxInFlightPerSku = Math.max(this.#maxInFlightPerSku, count);
  }

  #leave(key: string): void {
    const count = (this.#inFlight.get(key) ?? 1) - 1;
    if (count === 0) this.#inFlight.delete(key);
    else this.#inFlight.set(key, count);
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#timers.delete(timer);
        resolve();
      }, ms);
      this.#timers.add(timer);
    });
  }
}

function resolveRoute(
  method: string,
  id: string | undefined,
  verb: string | undefined,
): FakeAction | undefined {
  if (id === undefined) {
    if (method === 'POST') return 'create';
    if (method === 'GET') return 'read';
    return undefined;
  }
  if (verb === undefined) {
    if (method === 'GET') return 'read';
    if (method === 'PATCH') return 'update';
    return undefined;
  }
  if (method !== 'POST') return undefined;
  if (verb === 'end') return 'end';
  if (verb === 'relist') return 'relist';
  if (verb === 'mark-sold') return 'mark_sold';
  return undefined;
}

function validateCreate(
  body: Record<string, unknown>,
): Omit<FakeListing, 'id' | 'url' | 'revision'> {
  const { sku, title, description = '', priceCents, currency = 'USD', status = 'active' } = body;
  if (typeof sku !== 'string' || sku === '') {
    throw new HttpError(400, 'validation_failed', 'sku is required');
  }
  if (status !== 'active') {
    throw new HttpError(400, 'validation_failed', 'new listings must be active');
  }
  return {
    sku,
    status: 'active',
    title: validTitle(title),
    description: validDescription(description),
    priceCents: validPrice(priceCents),
    currency: validCurrency(currency),
  };
}

function validateUpdate(body: Record<string, unknown>): Partial<FakeListing> {
  const changes: Partial<FakeListing> = {};
  if (body['title'] !== undefined) changes.title = validTitle(body['title']);
  if (body['description'] !== undefined) {
    changes.description = validDescription(body['description']);
  }
  if (body['priceCents'] !== undefined) changes.priceCents = validPrice(body['priceCents']);
  if (body['currency'] !== undefined) changes.currency = validCurrency(body['currency']);
  if (Object.keys(changes).length === 0) {
    throw new HttpError(400, 'validation_failed', 'nothing to change');
  }
  return changes;
}

function validTitle(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 80) {
    throw new HttpError(400, 'validation_failed', 'title must be 1 to 80 characters');
  }
  return value;
}

function validDescription(value: unknown): string {
  if (typeof value !== 'string') {
    throw new HttpError(400, 'validation_failed', 'description must be text');
  }
  return value;
}

function validPrice(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new HttpError(400, 'validation_failed', 'price must be a positive number of cents');
  }
  return value;
}

function validCurrency(value: unknown): CurrencyCode {
  if (value !== 'USD') throw new HttpError(400, 'validation_failed', 'currency must be USD');
  return value;
}

function headerValue(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  return typeof value === 'string' && value !== '' ? value : null;
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function errorBody(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

function send(response: ServerResponse, reply: Reply): void {
  if (response.writableEnded || response.destroyed) return;
  response.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
  response.end(JSON.stringify(reply.body));
}
