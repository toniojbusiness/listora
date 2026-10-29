import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FakeDepopSite } from '@listora/automation';
import type { Db } from '@listora/db';
import { createMigratedDatabase } from '@listora/db/testing';
import { FakeEbay } from '@listora/marketplaces';
import { startNodeProcess, type StartedProcess } from '@listora/testing';

import { startStackControl, type FullStackControl } from './control.ts';
import {
  EbaySessionLinker,
  ebayNotificationEnv,
  insertDepopConnection,
  startMarketplaceFakes,
} from './marketplaces.ts';
import { connectEbay, type StackApi } from './seed.ts';

const API_ENTRY = fileURLToPath(new URL('../../../apps/api/src/main.ts', import.meta.url));
const WORKER_ENTRY = fileURLToPath(new URL('../../../apps/worker/src/main.ts', import.meta.url));

/** The signed-in user every stack starts with. */
export const E2E_EMAIL = 'e2e@listora.test';
/** The full stack's second seller, whose eBay is automated in the cloud. */
export const E2E_SECOND_EMAIL = 'e2e-second@listora.test';

/**
 * Which marketplaces the stack's seller uses. `ebay`: eBay through its API (the fake eBay), Depop
 * on the phone (the fake Depop site), and the others assisted. `all`: also Depop through its API
 * (the fake Depop), Poshmark and Mercari on the phone (their fake sites), eBay's notifications
 * delivered to the API, and a second seller whose eBay is automated in the cloud (the fake eBay
 * site, driven by the browser runner); see marketplaces.ts.
 */
export type StackMarketplaces = 'ebay' | 'all';

export interface LocalStackOptions {
  /** `AI_FAKE_FIXTURES_DIR` of the API and the worker (a `default.json` answers any photo set). */
  readonly fakeAiFixturesDir: string;
  /** Where `stop()` writes the API's and the worker's logs, for a failing run; none when unset. */
  readonly logDir?: string;
  /**
   * How long each process may take to start, in milliseconds (default 120 s). A first start right
   * after `npm ci` on a busy CI runner took the worker over 50 seconds before its first log line.
   */
  readonly startTimeoutMs?: number;
  /** Default `ebay`. */
  readonly marketplaces?: StackMarketplaces;
}

/** A signed-in user of the stack. */
export interface StackSeller {
  readonly email: string;
  /** A dev session token, valid for a day. */
  readonly accessToken: string;
}

export interface LocalStack {
  /** The API's base URL (`http://127.0.0.1:<port>`), also where its stored photos are served. */
  readonly apiUrl: string;
  readonly email: string;
  /** A dev session token for ``email``, valid for a day. */
  readonly accessToken: string;
  /** The stack's control endpoint for UI tests (eBay faults, ready items; control.ts). */
  readonly controlUrl: string;
  /** The fake Depop site the phone runtime acts on in the simulator. */
  readonly fakeDepopUrl: string;
  readonly marketplaces: StackMarketplaces;
  /** With `all` marketplaces: the second seller, whose eBay is automated in the cloud. */
  readonly secondSeller?: StackSeller;
  /** Stops every process, writes their logs, and drops the database and the stored files. */
  stop(): Promise<void>;
}

/**
 * The API and the worker as `npm run dev:api` and `npm run dev:worker` run them, with the fakes
 * of docs/architecture.md section 5: dev sign-in, local photo storage, the fake AI provider, and
 * the fake eBay (in this process, with a token vault key of the stack's own), with the user's
 * eBay account connected through its consent page. Each stack has a scratch database on the
 * test cluster (`scripts/dev-db.sh`), a storage directory, and ports of its own, so it never
 * touches the developer's dev data or a running dev API. With `all` marketplaces it also starts
 * the fakes of marketplaces.ts and lets the worker start the browser runner as a child process.
 * The worker never escalates on its own
 * (`AI_AUTO_ESCALATE=off`), so a test decides when "Identify harder" runs, and its operation
 * delays are a tenth of production's (`OPERATION_RETRY_DELAY_SCALE`), so an eBay change is
 * confirmed in seconds.
 */
export async function startLocalStack(options: LocalStackOptions): Promise<LocalStack> {
  const startTimeoutMs = options.startTimeoutMs ?? 120_000;
  const marketplaces = options.marketplaces ?? 'ebay';
  const database = await createMigratedDatabase('e2e', { jobQueue: true });
  const storageDir = await mkdtemp(join(tmpdir(), 'listora-e2e-storage-'));
  const processes: { name: string; process: StartedProcess }[] = [];
  const closers: (() => Promise<void>)[] = [];

  const stop = async (): Promise<void> => {
    for (const { process } of processes.toReversed()) await process.stop();
    for (const close of closers.toReversed()) await close();
    if (options.logDir !== undefined) await writeLogs(options.logDir, processes);
    await database.close();
    await rm(storageDir, { recursive: true, force: true });
  };

  try {
    const port = await freePort();
    const apiUrl = `http://127.0.0.1:${String(port)}`;
    // Local storage serves photos over http, which only a development fake eBay accepts.
    const fakeEbay = await FakeEbay.start({
      allowHttpPictures: true,
      allowHttpNotificationEndpoints: true,
      consentRedirect: { acceptUrl: `${apiUrl}/v1/connections/ebay/callback` },
    });
    closers.push(() => fakeEbay.close());
    // Depop runs on the phone (docs/features/phone-execution.md): the app's phone runtime acts
    // on this fake Depop site in the simulator, through the stack's API.
    const fakeDepop = await FakeDepopSite.start();
    closers.push(() => fakeDepop.close());
    const fakes = marketplaces === 'all' ? await startMarketplaceFakes() : undefined;
    if (fakes !== undefined) closers.push(() => fakes.close());
    const tokenKey = randomBytes(32);
    const shared = {
      PATH: process.env['PATH'],
      DATABASE_URL: database.scratch.url,
      // A CI runner busy with the simulator can take longer than the 5 s default to open a
      // connection to this healthy local Postgres; the request then failed and a UI test missed
      // the screen it waited for.
      DATABASE_CONNECT_TIMEOUT_MS: '30000',
      LOG_LEVEL: 'info',
      STORAGE_DRIVER: 'local',
      STORAGE_LOCAL_DIR: storageDir,
      STORAGE_LOCAL_BASE_URL: apiUrl,
      STORAGE_LOCAL_SIGNING_SECRET: randomBytes(32).toString('base64'),
      // Forwarded sale emails: dropped by the API's POST /dev/email, read by the worker.
      EMAIL_INGEST: 'folder',
      EMAIL_INBOX_DIR: join(storageDir, 'inbox'),
      AI_PROVIDER: 'fake',
      AI_FAKE_FIXTURES_DIR: options.fakeAiFixturesDir,
      EBAY_ENV: 'fake',
      EBAY_FAKE_URL: fakeEbay.url,
      FAKE_DEPOP_SITE_URL: fakeDepop.url,
      // The phone's runs are recorded by the API, under the worker's retry delays.
      OPERATION_RETRY_DELAY_SCALE: '0.1',
      // Every feature built, on the fakes, verified live or not (verified-features.md).
      MARKETPLACE_FEATURES: 'all',
      TOKEN_ENCRYPTION_KEY: tokenKey.toString('base64'),
      ...(fakes === undefined ? {} : { ...fakes.env, ...ebayNotificationEnv(apiUrl) }),
    };

    const api = startNodeProcess(API_ENTRY, {
      ...shared,
      API_HOST: '127.0.0.1',
      API_PORT: String(port),
      AUTH_DRIVER: 'dev',
      AUTH_DEV_SECRET: randomBytes(32).toString('base64'),
    });
    processes.push({ name: 'api', process: api });
    await api.waitForLog(
      (line) => typeof line['msg'] === 'string' && line['msg'].startsWith('Server listening at '),
      startTimeoutMs,
    );

    // Signed in first, so the account exists for the connections the worker reads at start.
    const accessToken = await signIn(api, apiUrl, E2E_EMAIL);
    const primary = { apiUrl, accessToken };
    const second =
      fakes === undefined
        ? undefined
        : { apiUrl, accessToken: await signIn(api, apiUrl, E2E_SECOND_EMAIL) };
    const workerEnv: NodeJS.ProcessEnv = { ...shared, AI_AUTO_ESCALATE: 'off' };
    let full: FullStackControl | undefined;
    if (fakes !== undefined && second !== undefined) {
      const primaryAccount = await accountIdOf(database.db, primary, E2E_EMAIL);
      const secondAccount = await accountIdOf(database.db, second, E2E_SECOND_EMAIL);
      Object.assign(workerEnv, {
        DEPOP_USER_CONNECTION_ID: await insertDepopConnection(
          database.db,
          primaryAccount,
          fakes.depop,
        ),
        BROWSER_RUNNER_LAUNCH: 'process',
        // Up for the whole run once started, so no step waits for a browser to start again.
        RUNNER_IDLE_EXIT_SECONDS: '0',
      });
      const ebayLinker = new EbaySessionLinker({
        db: database.db,
        tokenKey,
        workerEnv,
        site: fakes.ebaySite,
      });
      await ebayLinker.link(secondAccount);
      full = {
        fakes,
        ebayLinker,
        sellers: {
          primary: { ...primary, accountId: primaryAccount },
          second: { ...second, accountId: secondAccount },
        },
      };
    }

    const worker = startNodeProcess(WORKER_ENTRY, workerEnv);
    processes.push({ name: 'worker', process: worker });
    await worker.waitForLog((line) => line['msg'] === 'worker ready', startTimeoutMs);

    await connectEbay(primary, fakeEbay);
    const control = await startStackControl({
      api: primary,
      fakeEbay,
      fakeDepop,
      db: database.db,
      apiProcess: api,
      ...(full === undefined ? {} : { full }),
    });
    closers.push(() => control.close());
    return {
      apiUrl,
      email: E2E_EMAIL,
      accessToken,
      controlUrl: control.url,
      fakeDepopUrl: fakeDepop.url,
      marketplaces,
      ...(second === undefined
        ? {}
        : { secondSeller: { email: E2E_SECOND_EMAIL, accessToken: second.accessToken } }),
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

/**
 * The account a signed-in user owns (each stack user has exactly one). The API creates it on the
 * user's first request, so this makes one first.
 */
async function accountIdOf(db: Db, seller: StackApi, email: string): Promise<string> {
  const usage = await fetch(`${seller.apiUrl}/v1/usage`, {
    headers: { authorization: `Bearer ${seller.accessToken}` },
  });
  if (usage.status !== 200) throw new Error(`the API answered ${String(usage.status)}`);
  const row = await db
    .selectFrom('membership')
    .innerJoin('app_user', 'app_user.id', 'membership.user_id')
    .select('membership.account_id')
    .where('app_user.email', '=', email)
    .executeTakeFirstOrThrow();
  return row.account_id;
}

/** Signs in through the dev endpoints, reading the one-time code from the API's log. */
async function signIn(api: StartedProcess, apiUrl: string, email: string): Promise<string> {
  const post = async (path: string, body: unknown): Promise<Response> =>
    fetch(`${apiUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const requested = await post('/dev/auth/codes', { email });
  if (requested.status !== 202) {
    throw new Error(`requesting a dev sign-in code failed with ${String(requested.status)}`);
  }
  const line = await api.waitForLog((log) => log['email'] === email && 'devSignInCode' in log);
  const session = await post('/dev/auth/sessions', { email, code: line['devSignInCode'] });
  if (session.status !== 200) {
    throw new Error(`exchanging the dev sign-in code failed with ${String(session.status)}`);
  }
  const { accessToken } = (await session.json()) as { accessToken: string };
  return accessToken;
}

/** A TCP port nothing listens on right now. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address !== null && typeof address === 'object') resolve(address.port);
        else reject(new Error('no port assigned'));
      });
    });
  });
}

async function writeLogs(
  dir: string,
  processes: readonly { name: string; process: StartedProcess }[],
): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const { name, process } of processes) {
    const lines = process.logs.map((line) => JSON.stringify(line)).join('\n');
    await writeFile(join(dir, `${name}.log`), `${lines}\n${process.stderr}`);
  }
}

/** The stack's settings as environment variables, also with xcodebuild's `TEST_RUNNER_` prefix. */
export function stackEnvironment(
  stack: Pick<
    LocalStack,
    | 'apiUrl'
    | 'accessToken'
    | 'email'
    | 'controlUrl'
    | 'fakeDepopUrl'
    | 'marketplaces'
    | 'secondSeller'
  >,
): Record<string, string> {
  const settings = {
    LISTORA_E2E_API_BASE_URL: stack.apiUrl,
    LISTORA_E2E_ACCESS_TOKEN: stack.accessToken,
    LISTORA_E2E_EMAIL: stack.email,
    LISTORA_E2E_CONTROL_URL: stack.controlUrl,
    LISTORA_E2E_FAKE_DEPOP_URL: stack.fakeDepopUrl,
    LISTORA_E2E_MARKETPLACES: stack.marketplaces,
    ...(stack.secondSeller === undefined
      ? {}
      : {
          LISTORA_E2E_SECOND_ACCESS_TOKEN: stack.secondSeller.accessToken,
          LISTORA_E2E_SECOND_EMAIL: stack.secondSeller.email,
        }),
  };
  // xcodebuild passes TEST_RUNNER_<name> to the test runner as <name>.
  const forwarded = Object.fromEntries(
    Object.entries(settings).map(([name, value]) => [`TEST_RUNNER_${name}`, value]),
  );
  return { ...settings, ...forwarded };
}
