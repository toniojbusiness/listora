/**
 * The local stack's control endpoint, for UI tests: they run in the simulator and cannot reach
 * the fakes' in-process test controls, so the stack serves the few they need over HTTP on
 * 127.0.0.1. Development and tests only; nothing in the app ever calls it.
 *
 * Every stack:
 *
 * - `POST /ebay/faults` `{ action, fault, times? }`: the fake eBay fails matching requests
 *   (`FakeEbay.inject`). Only the faults below, which never need a long wait.
 * - `DELETE /ebay/faults`: removes every fault.
 * - `POST /items` `{ details?, seller? }`: a ready-to-list item with processed photos
 *   (`createReadyItem`), answering `{ id, sku }`.
 * - `POST /connections/ebay` `{ status }`: puts the user's eBay connection in a health state, as
 *   the daily check would have recorded it: `degraded` (eBay could not be asked) or
 *   `reauth_required` (eBay refused the grant), or back to `connected`, which a test that
 *   changed it must end with (the other tests list on eBay).
 * - `POST /items/listed` `{ details?, marketplaces?, wait?, seller? }`: such an item published on
 *   each marketplace (default eBay) and, unless `wait` is false, confirmed there
 *   (`createListedItem`), answering `{ id, sku, listingId, listings }`. A marketplace that runs
 *   on the phone confirms only once the app has run it, so a test with the app open passes
 *   `wait: false` and waits on the app's screens.
 * - `POST /today/sold-item`: a ready item (as above) kept in bin `B-12` that sold on eBay an hour
 *   ago and ships by tomorrow, answering `{ id, sku, saleId, saleItemId }`: a Today "ship" card.
 * - `POST /pack/orders`: Pack check turned on, and two sold items to pack whose labels Listora
 *   read (order A's `9400111899223197428490` and order B's `9400111899223197420001`, the
 *   double-print fixtures), answering `[{ id, sku, saleId, trackingNumber }]`.
 * - `POST /items/depop`: a ready item (as above) whose Depop listing is being published, answering
 *   `{ id, sku, listingId }`. Depop runs on the phone, so the publish waits for the app to run it.
 * - `POST /depop/faults` `{ action, fault, times? }`: the fake Depop site (which the phone
 *   runtime drives in the simulator, docs/features/phone-execution.md) shows a check on matching
 *   pages (`FakeDepopSite.inject`): a CAPTCHA, a bot check, a login code, or a signed-out page.
 * - `DELETE /depop/faults`: removes every fault.
 * - `GET /depop/products`: the fake Depop's products, `[{ slug, status, priceCents, description }]`.
 * - `POST /depop/offers` `{ slug, amountCents }`: a buyer makes an offer on that product on the
 *   fake Depop (docs/features/offers.md), answering `{ id }`.
 * - `GET /depop/offer-answers`: every answer the fake Depop took, `[{ offerId, action,
 *   counterCents }]`, so a test sees what was sent, and how often.
 * - `POST /depop/sessions` `{ seller? }`: a signed-in session cookie on the fake Depop, as signing
 *   in there would set, answering `{ name, value, domain, path }`.
 * - `GET /depop/sign-in-link`: the newest sign-in link the fake Depop "emailed" (its Email me a
 *   sign-in link), answering `{ link }`, or 404 when it emailed none.
 * - `GET /dev/sign-in-code?email=<email>`: the newest one-time code the API's dev sign-in printed
 *   for that email, answering `{ code }`: what the person signing in reads from their email.
 *
 * With `all` marketplaces (stack.ts) also:
 *
 * - `POST /depop-api/faults` `{ action, fault, times? }`: the fake Depop Selling API fails
 *   matching requests.
 * - `POST /automation/faults` `{ marketplace, action, fault, times? }`: the fake Poshmark, the
 *   fake Mercari site, or the fake eBay site shows a failure page on matching requests: a
 *   CAPTCHA or a login challenge (which automation must stop at), a signed-out page, a server
 *   error, or a validation refusal.
 * - `DELETE /faults`: removes every fault of every fake.
 * - `POST /ebay/sales` `{ sku }`: a buyer buys the item's eBay listing on the fake eBay, which
 *   then sends eBay's `ORDER_CONFIRMATION` notification to the API; answers `{ orderId }`.
 * - `POST /sessions/ebay`: links a fresh eBay session for the second seller, as relinking does.
 *
 * `seller` is `primary` (the default, the signed-in user) or `second` (the full stack's second
 * seller).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import type { FakeDepopSite, FakeDepopSiteAction } from '@listora/automation';
import type { Db, Marketplace } from '@listora/db';
import { DOUBLE_PRINT } from '@listora/pack-check/testing';
import type {
  FakeDepopAction,
  FakeDepopFault,
  FakeEbay,
  FakeEbayAction,
  FakeEbayFault,
} from '@listora/marketplaces';

import type { StartedProcess } from '@listora/testing';

import type { EbaySessionLinker, MarketplaceFakes } from './marketplaces.ts';
import {
  createListedItem,
  createQueuedDepopListing,
  createReadyItem,
  recordSoldItem,
  type StackApi,
  seedPackOrders,
} from './seed.ts';

const ACTIONS: readonly FakeEbayAction[] = ['add', 'revise', 'end', 'relist', 'get_item', 'media'];
const FAULTS = ['reject', 'server_error', 'system_error', 'rate_limited'] as const;
const MARKETPLACES: readonly Marketplace[] = ['ebay', 'depop', 'poshmark', 'mercari'];

const DEPOP_ACTIONS: readonly FakeDepopAction[] = ['put', 'patch', 'delete', 'mark_sold', 'get'];
const DEPOP_FAULTS = ['reject', 'server_error', 'rate_limited'] as const;

/** The fake sites `POST /automation/faults` fails, by marketplace. */
type FaultedSite = 'poshmark' | 'mercari' | 'ebay';

/** The pages each fake site can fail, by the fake's own action names. */
const AUTOMATION_ACTIONS: Readonly<Record<FaultedSite, readonly string[]>> = {
  poshmark: ['new_form', 'create', 'edit_form', 'update', 'listing', 'closet'],
  mercari: ['form', 'create', 'update', 'end', 'relist', 'read', 'listings', 'health'],
  ebay: ['form', 'create', 'update', 'relist', 'end', 'read', 'listings', 'sold', 'health'],
};
/** The faults every fake site has; each fails before anything is applied. */
const AUTOMATION_FAULTS = [
  'captcha',
  'login_challenge',
  'session_expired',
  'server_error',
  'reject',
] as const;

export interface StackControl {
  /** `http://127.0.0.1:<port>`. */
  readonly url: string;
  close(): Promise<void>;
}

/** A seller of the full stack: their API session and account. */
export interface ControlSeller extends StackApi {
  readonly accountId: string;
}

/** What the full stack (`all` marketplaces) adds. */
export interface FullStackControl {
  fakes: MarketplaceFakes;
  ebayLinker: EbaySessionLinker;
  sellers: { primary: ControlSeller; second: ControlSeller };
}

interface ControlDependencies {
  api: StackApi;
  fakeEbay: FakeEbay;
  fakeDepop: FakeDepopSite;
  /** The stack's database, for the connection states the daily check would record. */
  db: Db;
  /** The API process, whose log has the dev sign-in codes. */
  apiProcess: StartedProcess;
  full?: FullStackControl;
}

interface Reply {
  status: number;
  body?: unknown;
}

export async function startStackControl(deps: ControlDependencies): Promise<StackControl> {
  const server = createServer((request, response) => {
    handle(request, deps).then(
      (result) => {
        reply(response, result.status, result.body);
      },
      (error: unknown) => {
        reply(response, 500, { error: error instanceof Error ? error.message : String(error) });
      },
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address !== 'object') throw new Error('no control port');
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

async function handle(request: IncomingMessage, deps: ControlDependencies): Promise<Reply> {
  const url = new URL(request.url ?? '/', 'http://control');
  if (request.method === 'GET' && url.pathname === '/dev/sign-in-code') {
    const email = url.searchParams.get('email');
    const line = deps.apiProcess.logs.findLast(
      (log) => log['email'] === email && typeof log['devSignInCode'] === 'string',
    );
    return line === undefined
      ? { status: 404, body: { error: `no dev sign-in code for ${String(email)}` } }
      : { status: 200, body: { code: line['devSignInCode'] } };
  }
  const route = `${request.method ?? ''} ${request.url ?? ''}`;
  switch (route) {
    case 'POST /ebay/faults': {
      const rule = faultRule(await readJson(request));
      if (typeof rule === 'string') return refused(rule);
      deps.fakeEbay.inject(rule);
      return { status: 204 };
    }
    case 'DELETE /ebay/faults':
      deps.fakeEbay.clearFaults();
      return { status: 204 };
    case 'POST /items': {
      const body = await readJson(request);
      const api = sellerApi(deps, body);
      if (typeof api === 'string') return refused(api);
      return { status: 201, body: await createReadyItem(api, detailsIn(body)) };
    }
    case 'POST /items/listed': {
      const body = await readJson(request);
      const api = sellerApi(deps, body);
      if (typeof api === 'string') return refused(api);
      const marketplaces = marketplacesIn(body, deps);
      if (typeof marketplaces === 'string') return refused(marketplaces);
      return {
        status: 201,
        body: await createListedItem(api, detailsIn(body), marketplaces, {
          wait: field(body, 'wait') !== false,
        }),
      };
    }
    case 'POST /items/depop':
      return {
        status: 201,
        body: await createQueuedDepopListing(deps.api, detailsIn(await readJson(request))),
      };
    case 'POST /depop/faults': {
      const rule = depopSiteFaultRule(await readJson(request));
      if (typeof rule === 'string') return refused(rule);
      deps.fakeDepop.inject(rule);
      return { status: 204 };
    }
    case 'DELETE /depop/faults':
      deps.fakeDepop.clearFaults();
      return { status: 204 };
    case 'GET /depop/products':
      return {
        status: 200,
        body: deps.fakeDepop.products().map((product) => ({
          slug: product.slug,
          status: product.status,
          priceCents: product.priceCents,
          description: product.description,
        })),
      };
    case 'POST /depop/offers': {
      const body = await readJson(request);
      const slug = field(body, 'slug');
      const amountCents = field(body, 'amountCents');
      if (typeof slug !== 'string' || typeof amountCents !== 'number') {
        return refused('an offer needs a slug and an amountCents');
      }
      const product = deps.fakeDepop.products().find((each) => each.slug === slug);
      const offer = deps.fakeDepop.offers.add({
        listingId: slug,
        listingTitle: product?.description.split('\n')[0] ?? 'A listing',
        amountCents,
        listPriceCents: product?.priceCents ?? amountCents + 1000,
        buyer: 'e2e-buyer',
      });
      return { status: 201, body: { id: offer.id } };
    }
    case 'GET /depop/offer-answers':
      return {
        status: 200,
        body: deps.fakeDepop.offers.answers.map((answer) => ({
          offerId: answer.offerId,
          action: answer.action,
          counterCents: answer.counterCents,
        })),
      };
    case 'GET /depop/sign-in-link': {
      const link = deps.fakeDepop.signInLinks().at(-1);
      return link === undefined
        ? { status: 404, body: { error: 'the fake Depop emailed no sign-in link' } }
        : { status: 200, body: { link } };
    }
    case 'POST /depop/sessions': {
      const seller = field(await readJson(request), 'seller');
      const cookie = deps.fakeDepop.issueSession(
        typeof seller === 'string' ? seller : 'e2e-seller',
      );
      return {
        status: 201,
        body: { name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path },
      };
    }
    case 'POST /pack/orders': {
      const tee = await createReadyItem(deps.api, {
        title: 'Shaka Wear Heavyweight Tee',
        brand: 'Shaka Wear',
        category: 'clothing/tops/t_shirts',
        sizeLabel: '2XL',
        colors: ['black'],
      });
      const dress = await createReadyItem(deps.api, {
        title: 'Free People Midi Dress',
        brand: 'Free People',
        department: 'women',
        category: 'clothing/dresses/dresses',
        sizeLabel: 'S',
        colors: ['green'],
      });
      return {
        status: 201,
        body: await seedPackOrders(
          deps.db,
          [tee, dress],
          [DOUBLE_PRINT.trackingA, DOUBLE_PRINT.trackingB],
        ),
      };
    }
    case 'POST /today/sold-item': {
      const item = await createReadyItem(deps.api, { title: 'Wrangler Western Shirt' });
      return { status: 201, body: await recordSoldItem(deps.db, item) };
    }
    case 'POST /connections/ebay': {
      const body = await readJson(request);
      const status = field(body, 'status');
      const state = CONNECTION_STATES.find((candidate) => candidate.status === status);
      if (state === undefined) {
        return refused(
          `status must be one of ${CONNECTION_STATES.map((s) => s.status).join(', ')}`,
        );
      }
      await setEbayConnection(deps.db, state);
      return { status: 204 };
    }
    default:
      if (deps.full !== undefined) {
        const answer = await handleFull(request, route, deps, deps.full);
        if (answer !== undefined) return answer;
      }
      return { status: 404, body: { error: `no control route ${route}` } };
  }
}

/** The full stack's routes; `undefined` for a route it does not have. */
async function handleFull(
  request: IncomingMessage,
  route: string,
  deps: ControlDependencies,
  full: FullStackControl,
): Promise<Reply | undefined> {
  const { fakes } = full;
  switch (route) {
    case 'POST /depop-api/faults': {
      const rule = depopFaultRule(await readJson(request));
      if (typeof rule === 'string') return refused(rule);
      fakes.depop.inject(rule);
      return { status: 204 };
    }
    case 'POST /automation/faults': {
      const rule = automationFaultRule(await readJson(request));
      if (typeof rule === 'string') return refused(rule);
      injectAutomationFault(fakes, rule);
      return { status: 204 };
    }
    case 'DELETE /faults':
      deps.fakeEbay.clearFaults();
      fakes.depop.clearFaults();
      fakes.poshmark.clearFaults();
      fakes.mercari.clearFaults();
      fakes.ebaySite.clearFaults();
      deps.fakeDepop.clearFaults();
      return { status: 204 };
    case 'POST /ebay/sales': {
      const sku = field(await readJson(request), 'sku');
      if (typeof sku !== 'string') return refused('sku must be a string');
      const listing = await deps.db
        .selectFrom('marketplace_listing')
        .innerJoin('inventory_item', (join) =>
          join
            .onRef('inventory_item.id', '=', 'marketplace_listing.item_id')
            .onRef('inventory_item.account_id', '=', 'marketplace_listing.account_id'),
        )
        .select('marketplace_listing.external_listing_id')
        .where('inventory_item.sku', '=', sku)
        .where('marketplace_listing.marketplace', '=', 'ebay')
        .executeTakeFirst();
      const ebayItemId = listing?.external_listing_id ?? null;
      if (ebayItemId === null) return refused(`${sku} is not listed on eBay`);
      const order = deps.fakeEbay.sell(ebayItemId);
      return { status: 201, body: { orderId: order.orderId } };
    }
    case 'POST /sessions/ebay':
      return {
        status: 201,
        body: { connectionId: await full.ebayLinker.link(full.sellers.second.accountId) },
      };
    default:
      return undefined;
  }
}

/** The states `POST /connections/ebay` sets, in the words the health check records. */
const CONNECTION_STATES = [
  { status: 'connected', problem: undefined },
  {
    status: 'degraded',
    problem: { code: 'marketplace_error', message: 'eBay had a problem answering Listora.' },
  },
  {
    status: 'reauth_required',
    problem: {
      code: 'grant_revoked',
      message: "eBay no longer accepts Listora's access. Reconnect eBay.",
    },
  },
] as const;

/** The stack's signed-in user has the stack's one eBay connection. */
async function setEbayConnection(db: Db, state: (typeof CONNECTION_STATES)[number]): Promise<void> {
  const now = new Date();
  await db
    .updateTable('marketplace_connection')
    .set({
      status: state.status,
      last_checked_at: now,
      check_requested_at: null,
      ...(state.problem === undefined
        ? { last_ok_at: now, last_error: null, last_error_code: null, last_error_at: null }
        : {
            last_error: state.problem.message,
            last_error_code: state.problem.code,
            last_error_at: now,
          }),
    })
    .where('marketplace', '=', 'ebay')
    .execute();
}

function field(body: unknown, name: string): unknown {
  return typeof body === 'object' && body !== null && name in body
    ? (body as Record<string, unknown>)[name]
    : undefined;
}

function detailsIn(body: unknown): Record<string, unknown> {
  const details = field(body, 'details');
  return typeof details === 'object' && details !== null
    ? (details as Record<string, unknown>)
    : {};
}

/** The seller a request is for, or why it is refused. */
function sellerApi(deps: ControlDependencies, body: unknown): StackApi | string {
  const seller = field(body, 'seller') ?? 'primary';
  if (seller === 'primary') return deps.api;
  if (seller === 'second' && deps.full !== undefined) return deps.full.sellers.second;
  return deps.full === undefined
    ? 'seller must be primary'
    : 'seller must be one of primary, second';
}

/** The marketplaces an item is listed on (default eBay), or why they are refused. */
function marketplacesIn(body: unknown, deps: ControlDependencies): Marketplace[] | string {
  const raw = field(body, 'marketplaces') ?? ['ebay'];
  const offered = deps.full === undefined ? ['ebay'] : MARKETPLACES;
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.some((marketplace) => !offered.includes(marketplace as Marketplace))
  ) {
    return `marketplaces must be a list of ${offered.join(', ')}`;
  }
  return [...new Set(raw as Marketplace[])];
}

/** The fault rule a request asks for, or why it is refused. */
function faultRule(
  body: unknown,
): { action: FakeEbayAction; fault: FakeEbayFault; times: number } | string {
  if (typeof body !== 'object' || body === null) return 'expected a JSON object';
  const { action, fault, times } = body as Record<string, unknown>;
  const knownAction = ACTIONS.find((candidate) => candidate === action);
  if (knownAction === undefined) return `action must be one of ${ACTIONS.join(', ')}`;
  const parsed = faultOf(fault, FAULTS);
  if (typeof parsed === 'string') return parsed;
  const count = timesOf(times);
  if (typeof count === 'string') return count;
  const chosen: FakeEbayFault =
    parsed.type === 'reject'
      ? { type: 'reject', ...(parsed.message === undefined ? {} : { message: parsed.message }) }
      : { type: parsed.type };
  return { action: knownAction, fault: chosen, times: count };
}

function depopFaultRule(
  body: unknown,
): { action: FakeDepopAction; fault: FakeDepopFault; times: number } | string {
  if (typeof body !== 'object' || body === null) return 'expected a JSON object';
  const { action, fault, times } = body as Record<string, unknown>;
  const knownAction = DEPOP_ACTIONS.find((candidate) => candidate === action);
  if (knownAction === undefined) return `action must be one of ${DEPOP_ACTIONS.join(', ')}`;
  const parsed = faultOf(fault, DEPOP_FAULTS);
  if (typeof parsed === 'string') return parsed;
  const count = timesOf(times);
  if (typeof count === 'string') return count;
  const chosen: FakeDepopFault =
    parsed.type === 'reject'
      ? { type: 'reject', ...(parsed.message === undefined ? {} : { message: parsed.message }) }
      : { type: parsed.type };
  return { action: knownAction, fault: chosen, times: count };
}

interface AutomationFaultRule {
  marketplace: FaultedSite;
  action: string;
  fault: { type: (typeof AUTOMATION_FAULTS)[number]; message?: string };
  times: number;
}

function automationFaultRule(body: unknown): AutomationFaultRule | string {
  if (typeof body !== 'object' || body === null) return 'expected a JSON object';
  const { marketplace, action, fault, times } = body as Record<string, unknown>;
  if (marketplace !== 'poshmark' && marketplace !== 'mercari' && marketplace !== 'ebay') {
    return 'marketplace must be one of poshmark, mercari, ebay';
  }
  const actions = AUTOMATION_ACTIONS[marketplace];
  if (typeof action !== 'string' || !actions.includes(action)) {
    return `action must be one of ${actions.join(', ')}`;
  }
  const parsed = faultOf(fault, AUTOMATION_FAULTS);
  if (typeof parsed === 'string') return parsed;
  const count = timesOf(times);
  if (typeof count === 'string') return count;
  return { marketplace, action, fault: parsed, times: count };
}

/** Puts the rule on the marketplace's fake site, in that fake's own fault shapes. */
function injectAutomationFault(fakes: MarketplaceFakes, rule: AutomationFaultRule): void {
  const fault = siteFault(rule.fault);
  switch (rule.marketplace) {
    case 'poshmark':
      fakes.poshmark.inject({
        action: rule.action as Parameters<MarketplaceFakes['poshmark']['inject']>[0]['action'],
        fault,
        times: rule.times,
      });
      return;
    case 'mercari':
      fakes.mercari.inject({
        action: rule.action as Parameters<MarketplaceFakes['mercari']['inject']>[0]['action'],
        fault,
        times: rule.times,
      });
      return;
    case 'ebay':
      fakes.ebaySite.inject({
        action: rule.action as Parameters<MarketplaceFakes['ebaySite']['inject']>[0]['action'],
        fault,
        times: rule.times,
      });
      return;
  }
}

const DEPOP_SITE_ACTIONS: readonly FakeDepopSiteAction[] = [
  'create',
  'update',
  'delete',
  'read',
  'health',
  'form',
];
const DEPOP_SITE_FAULTS = ['captcha', 'bot_check', 'login_challenge', 'session_expired'] as const;

/** A check the fake Depop site shows, as a request asks for it, or why it is refused. */
function depopSiteFaultRule(body: unknown):
  | {
      action: FakeDepopSiteAction;
      fault: { type: (typeof DEPOP_SITE_FAULTS)[number] };
      times: number;
    }
  | string {
  if (typeof body !== 'object' || body === null) return 'expected a JSON object';
  const { action, fault, times } = body as Record<string, unknown>;
  const knownAction = DEPOP_SITE_ACTIONS.find((candidate) => candidate === action);
  if (knownAction === undefined) return `action must be one of ${DEPOP_SITE_ACTIONS.join(', ')}`;
  const parsed = faultOf(fault, DEPOP_SITE_FAULTS);
  if (typeof parsed === 'string') return parsed;
  const count = timesOf(times);
  if (typeof count === 'string') return count;
  return { action: knownAction, fault: { type: parsed.type }, times: count };
}

/** A fault every fake site has, in the shape they share. */
type SiteFault =
  | { type: 'captcha' | 'login_challenge' | 'session_expired' }
  | { type: 'server_error'; afterApply: boolean }
  | { type: 'reject'; message: string };

function siteFault(fault: AutomationFaultRule['fault']): SiteFault {
  switch (fault.type) {
    case 'reject':
      return { type: 'reject', message: fault.message ?? 'This listing cannot be posted.' };
    case 'server_error':
      return { type: 'server_error', afterApply: false };
    case 'captcha':
    case 'login_challenge':
    case 'session_expired':
      return { type: fault.type };
  }
}

function faultOf<T extends string>(
  fault: unknown,
  types: readonly T[],
): { type: T; message?: string } | string {
  if (typeof fault !== 'object' || fault === null) return 'fault must be an object';
  const { type, message } = fault as Record<string, unknown>;
  const known = types.find((candidate) => candidate === type);
  if (known === undefined) return `fault.type must be one of ${types.join(', ')}`;
  return { type: known, ...(typeof message === 'string' ? { message } : {}) };
}

function timesOf(times: unknown): number | string {
  const count = times ?? 1;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 100) {
    return 'times must be an integer from 1 to 100';
  }
  return count;
}

function refused(error: string): Reply {
  return { status: 422, body: { error } };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? {} : (JSON.parse(text) as unknown);
}

function reply(response: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    response.writeHead(status).end();
    return;
  }
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}
