/**
 * The local stack's control endpoint, for UI tests: they run in the simulator and cannot reach
 * the fakes' in-process test controls, so the stack serves the few they need over HTTP on
 * 127.0.0.1. Development and tests only; nothing in the app ever calls it.
 *
 * - `POST /ebay/faults` `{ action, fault, times? }`: the fake eBay fails matching requests
 *   (`FakeEbay.inject`). Only the faults below, which never need a long wait.
 * - `DELETE /ebay/faults`: removes every fault.
 * - `POST /items` `{ details? }`: a ready-to-list item with processed photos (`createReadyItem`),
 *   answering `{ id, sku }`.
 * - `POST /items/listed` `{ details? }`: such an item published on eBay and confirmed active
 *   (`createListedItem`), answering `{ id, sku, listingId }`.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import type { FakeEbay, FakeEbayAction, FakeEbayFault } from '@listora/marketplaces';

import { createListedItem, createReadyItem, type StackApi } from './seed.ts';

const ACTIONS: readonly FakeEbayAction[] = ['add', 'revise', 'end', 'relist', 'get_item', 'media'];
const FAULTS = ['reject', 'server_error', 'system_error', 'rate_limited'] as const;

export interface StackControl {
  /** `http://127.0.0.1:<port>`. */
  readonly url: string;
  close(): Promise<void>;
}

export async function startStackControl(deps: {
  api: StackApi;
  fakeEbay: FakeEbay;
}): Promise<StackControl> {
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

async function handle(
  request: IncomingMessage,
  deps: { api: StackApi; fakeEbay: FakeEbay },
): Promise<{ status: number; body?: unknown }> {
  const route = `${request.method ?? ''} ${request.url ?? ''}`;
  switch (route) {
    case 'POST /ebay/faults': {
      const rule = faultRule(await readJson(request));
      if (typeof rule === 'string') return { status: 422, body: { error: rule } };
      deps.fakeEbay.inject(rule);
      return { status: 204 };
    }
    case 'DELETE /ebay/faults':
      deps.fakeEbay.clearFaults();
      return { status: 204 };
    case 'POST /items':
      return {
        status: 201,
        body: await createReadyItem(deps.api, detailsIn(await readJson(request))),
      };
    case 'POST /items/listed':
      return {
        status: 201,
        body: await createListedItem(deps.api, detailsIn(await readJson(request))),
      };
    default:
      return { status: 404, body: { error: `no control route ${route}` } };
  }
}

function detailsIn(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null && 'details' in body
    ? (body.details as Record<string, unknown>)
    : {};
}

/** The fault rule a request asks for, or why it is refused. */
function faultRule(
  body: unknown,
): { action: FakeEbayAction; fault: FakeEbayFault; times: number } | string {
  if (typeof body !== 'object' || body === null) return 'expected a JSON object';
  const { action, fault, times } = body as Record<string, unknown>;
  const knownAction = ACTIONS.find((candidate) => candidate === action);
  if (knownAction === undefined) return `action must be one of ${ACTIONS.join(', ')}`;
  if (typeof fault !== 'object' || fault === null) return 'fault must be an object';
  const { type, message } = fault as Record<string, unknown>;
  const knownType = FAULTS.find((candidate) => candidate === type);
  if (knownType === undefined) return `fault.type must be one of ${FAULTS.join(', ')}`;
  const count = times ?? 1;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 100) {
    return 'times must be an integer from 1 to 100';
  }
  const chosen: FakeEbayFault =
    knownType === 'reject'
      ? { type: 'reject', ...(typeof message === 'string' ? { message } : {}) }
      : { type: knownType };
  return { action: knownAction, fault: chosen, times: count };
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
