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
 * - `POST /connections/ebay` `{ status }`: puts the user's eBay connection in a health state, as
 *   the daily check would have recorded it: `degraded` (eBay could not be asked) or
 *   `reauth_required` (eBay refused the grant), or back to `connected`, which a test that
 *   changed it must end with (the other tests list on eBay).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import type { Db } from '@listora/db';
import type { FakeEbay, FakeEbayAction, FakeEbayFault } from '@listora/marketplaces';

import { createReadyItem, type StackApi } from './seed.ts';

const ACTIONS: readonly FakeEbayAction[] = ['add', 'revise', 'end', 'relist', 'get_item', 'media'];
const FAULTS = ['reject', 'server_error', 'system_error', 'rate_limited'] as const;

export interface StackControl {
  /** `http://127.0.0.1:<port>`. */
  readonly url: string;
  close(): Promise<void>;
}

interface ControlDependencies {
  api: StackApi;
  fakeEbay: FakeEbay;
  /** The stack's database, for the connection states the daily check would record. */
  db: Db;
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

async function handle(
  request: IncomingMessage,
  deps: ControlDependencies,
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
    case 'POST /items': {
      const body = await readJson(request);
      const details =
        typeof body === 'object' && body !== null && 'details' in body
          ? (body.details as Record<string, unknown>)
          : {};
      return { status: 201, body: await createReadyItem(deps.api, details) };
    }
    case 'POST /connections/ebay': {
      const body = await readJson(request);
      const status =
        typeof body === 'object' && body !== null && 'status' in body ? body.status : undefined;
      const state = CONNECTION_STATES.find((candidate) => candidate.status === status);
      if (state === undefined) {
        return {
          status: 422,
          body: {
            error: `status must be one of ${CONNECTION_STATES.map((s) => s.status).join(', ')}`,
          },
        };
      }
      await setEbayConnection(deps.db, state);
      return { status: 204 };
    }
    default:
      return { status: 404, body: { error: `no control route ${route}` } };
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

/** The stack has one signed-in user, so one eBay connection. */
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
