// Post-deploy smoke test of a deployed API (scripts/deploy-personal.sh runs it after every
// deploy; infra/README.md, The personal environment's first deploy). It checks health, signs
// in with the environment's configured auth driver, creates a draft item, reads it back, and
// deletes it. It never starts an analysis or touches a marketplace, so it costs no AI usage
// and changes nothing outside Listora. With the dev driver it also deletes the throwaway
// account it signed in to, leaving nothing behind.
//
//   node infra/src/deploy/smoke.ts --api-url <url> --auth dev --log-group /listora/<env>/api
//   LISTORA_SMOKE_ID_TOKEN=<id token> node infra/src/deploy/smoke.ts --api-url <url> --auth cognito
//
// The dev driver prints sign-in codes to the API log, so the dev path reads its code from the
// API's CloudWatch log group with the ambient AWS credentials (`aws logs filter-log-events`).
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';

/** How the smoke test gets a bearer token: the driver the deployed API is configured with. */
export type SmokeAuth =
  | {
      readonly driver: 'dev';
      /** The sign-in code the API logged for `email` at or after `sinceMs`. */
      readonly readCode: (email: string, sinceMs: number) => Promise<string>;
    }
  | {
      readonly driver: 'cognito';
      /** An ID token of a dedicated smoke-test user of the environment's user pool. */
      readonly idToken: string;
    };

export interface SmokeOptions {
  readonly apiUrl: string;
  readonly auth: SmokeAuth;
  readonly log: (line: string) => void;
  /** Milliseconds since the epoch; injectable for tests. */
  readonly now?: () => number;
}

/** A failed smoke step; `step` names what was being checked. */
export class SmokeFailure extends Error {
  readonly step: string;

  constructor(step: string, message: string) {
    super(`${step}: ${message}`);
    this.name = 'SmokeFailure';
    this.step = step;
  }
}

interface Reply {
  readonly status: number;
  readonly body: unknown;
}

/** Runs every smoke step in order; throws `SmokeFailure` at the first one that fails. */
export async function runSmoke(options: SmokeOptions): Promise<void> {
  const base = options.apiUrl.replace(/\/+$/, '');
  const now = options.now ?? Date.now;
  const call = async (method: string, path: string, init: RequestInit = {}): Promise<Reply> => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      method,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = text === '' ? undefined : JSON.parse(text);
    } catch {
      // Not JSON (a gateway error page, say); keep the text for the failure message.
    }
    return { status: response.status, body };
  };
  const expectStatus = (step: string, reply: Reply, status: number): void => {
    if (reply.status !== status) {
      throw new SmokeFailure(
        step,
        `expected HTTP ${String(status)}, got ${String(reply.status)}: ${JSON.stringify(reply.body)}`,
      );
    }
  };
  const field = (value: unknown, key: string): unknown =>
    typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)[key]
      : undefined;

  expectStatus('health/live', await call('GET', '/health/live'), 200);
  const ready = await call('GET', '/health/ready');
  expectStatus('health/ready', ready, 200);
  if (field(field(ready.body, 'checks'), 'database') !== 'ok') {
    throw new SmokeFailure('health/ready', `database not ok: ${JSON.stringify(ready.body)}`);
  }
  options.log('smoke: health ok (live, and ready with the database reachable)');

  let token: string;
  const email = `smoke-${randomBytes(6).toString('hex')}@example.com`;
  if (options.auth.driver === 'dev') {
    const json = { 'content-type': 'application/json' };
    const since = now();
    const requested = await call('POST', '/dev/auth/codes', {
      headers: json,
      body: JSON.stringify({ email }),
    });
    expectStatus('sign-in (dev): request a code', requested, 202);
    const code = await options.auth.readCode(email, since);
    const session = await call('POST', '/dev/auth/sessions', {
      headers: json,
      body: JSON.stringify({ email, code }),
    });
    expectStatus('sign-in (dev): exchange the code', session, 200);
    const accessToken = field(session.body, 'accessToken');
    if (typeof accessToken !== 'string') {
      throw new SmokeFailure('sign-in (dev)', 'the session has no accessToken');
    }
    token = accessToken;
    options.log(`smoke: signed in with the dev driver as ${email}`);
  } else {
    token = options.auth.idToken;
    options.log('smoke: signing in with the Cognito ID token');
  }
  const authorized = (headers: Record<string, string> = {}) => ({
    authorization: `Bearer ${token}`,
    ...headers,
  });

  let itemId: string | undefined;
  let failure: Error | undefined;
  try {
    const created = await call('POST', '/v1/items', {
      headers: authorized({ 'content-type': 'application/json', 'idempotency-key': randomUUID() }),
      body: JSON.stringify({ details: { title: 'Listora deploy smoke test' } }),
    });
    expectStatus('create an item', created, 201);
    const id = field(created.body, 'id');
    const sku = field(created.body, 'sku');
    if (typeof id !== 'string' || typeof sku !== 'string') {
      throw new SmokeFailure('create an item', `no id or sku: ${JSON.stringify(created.body)}`);
    }
    itemId = id;
    if (field(created.body, 'status') !== 'draft') {
      throw new SmokeFailure('create an item', `expected a draft: ${JSON.stringify(created.body)}`);
    }
    options.log(`smoke: created draft item ${sku}`);

    const read = await call('GET', `/v1/items/${id}`, { headers: authorized() });
    expectStatus('read the item', read, 200);
    if (field(read.body, 'sku') !== sku) {
      throw new SmokeFailure('read the item', `expected ${sku}: ${JSON.stringify(read.body)}`);
    }

    expectStatus(
      'delete the item',
      await call('DELETE', `/v1/items/${id}`, { headers: authorized() }),
      204,
    );
    itemId = undefined;
    expectStatus(
      'the deleted item is gone',
      await call('GET', `/v1/items/${id}`, { headers: authorized() }),
      404,
    );
    options.log(`smoke: deleted item ${sku}`);
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    // Leave nothing behind, even after a failed step: the item, then (dev only) the account.
    // A Cognito user is kept, since deleting the account would delete the smoke user too.
    if (itemId !== undefined) {
      await call('DELETE', `/v1/items/${itemId}`, { headers: authorized() }).catch(() => undefined);
    }
    if (options.auth.driver === 'dev') {
      const deleted = await call('DELETE', '/v1/account', { headers: authorized() }).catch(
        (error: unknown) => ({ status: 0, body: String(error) }),
      );
      if (failure === undefined && deleted.status !== 200) {
        failure = new SmokeFailure(
          'delete the smoke account',
          `expected HTTP 200, got ${String(deleted.status)}: ${JSON.stringify(deleted.body)}`,
        );
      } else if (failure === undefined) {
        options.log('smoke: deleted the smoke account');
      }
    }
  }
  if (failure !== undefined) throw failure;
  options.log('smoke: ok');
}

const execFileAsync = promisify(execFile);

/**
 * Reads a dev sign-in code from the API's CloudWatch log group: the JSON log line the dev
 * driver writes (`{ email, devSignInCode }`). Log delivery takes seconds, so it polls for up to
 * two minutes.
 */
export function cloudWatchCodeReader(
  logGroup: string,
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
): (email: string, sinceMs: number) => Promise<string> {
  return async (email, sinceMs) => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const { stdout } = await execFileAsync('aws', [
        'logs',
        'filter-log-events',
        '--log-group-name',
        logGroup,
        '--start-time',
        String(sinceMs - 60_000),
        '--filter-pattern',
        `{ $.email = "${email}" && $.devSignInCode = * }`,
        '--output',
        'json',
      ]);
      const events = (JSON.parse(stdout) as { events?: { message?: string }[] }).events ?? [];
      for (const event of events.toReversed()) {
        try {
          const line = JSON.parse(event.message ?? '') as {
            email?: unknown;
            devSignInCode?: unknown;
          };
          if (line.email === email && typeof line.devSignInCode === 'string') {
            return line.devSignInCode;
          }
        } catch {
          // Not a JSON log line.
        }
      }
      await sleep(3_000);
    }
    throw new SmokeFailure('sign-in (dev)', `no sign-in code for ${email} in ${logGroup}`);
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { values } = parseArgs({
    options: {
      'api-url': { type: 'string' },
      auth: { type: 'string' },
      'log-group': { type: 'string' },
    },
  });
  const apiUrl = values['api-url'];
  const usage =
    'usage: node infra/src/deploy/smoke.ts --api-url <url> --auth dev --log-group <group>\n' +
    '       LISTORA_SMOKE_ID_TOKEN=<token> node infra/src/deploy/smoke.ts --api-url <url> --auth cognito\n';
  let auth: SmokeAuth | undefined;
  if (values.auth === 'dev' && values['log-group'] !== undefined) {
    auth = { driver: 'dev', readCode: cloudWatchCodeReader(values['log-group']) };
  } else if (values.auth === 'cognito') {
    const idToken = process.env['LISTORA_SMOKE_ID_TOKEN'];
    if (idToken === undefined || idToken === '') {
      process.stderr.write('smoke: --auth cognito needs LISTORA_SMOKE_ID_TOKEN (.env.example)\n');
      process.exit(2);
    }
    auth = { driver: 'cognito', idToken };
  }
  if (apiUrl === undefined || auth === undefined) {
    process.stderr.write(usage);
    process.exit(2);
  }
  try {
    await runSmoke({ apiUrl, auth, log: (line) => process.stdout.write(`${line}\n`) });
  } catch (error) {
    process.stderr.write(
      `smoke: FAILED: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}
