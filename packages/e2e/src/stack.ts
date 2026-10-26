import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMigratedDatabase } from '@listora/db/testing';
import { FakeDepopSite } from '@listora/automation';
import { FakeEbay } from '@listora/marketplaces';
import { startNodeProcess, type StartedProcess } from '@listora/testing';

import { startStackControl } from './control.ts';
import { connectEbay } from './seed.ts';

const API_ENTRY = fileURLToPath(new URL('../../../apps/api/src/main.ts', import.meta.url));
const WORKER_ENTRY = fileURLToPath(new URL('../../../apps/worker/src/main.ts', import.meta.url));

/** The signed-in user every stack starts with. */
export const E2E_EMAIL = 'e2e@listora.test';

export interface LocalStackOptions {
  /** `AI_FAKE_FIXTURES_DIR` of the API and the worker (a `default.json` answers any photo set). */
  readonly fakeAiFixturesDir: string;
  /** Where `stop()` writes the API's and the worker's logs, for a failing run; none when unset. */
  readonly logDir?: string;
  /** How long each process may take to start, in milliseconds. */
  readonly startTimeoutMs?: number;
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
  /** Stops both processes, writes their logs, and drops the database and the stored files. */
  stop(): Promise<void>;
}

/**
 * The API and the worker as `npm run dev:api` and `npm run dev:worker` run them, with the fakes
 * of docs/architecture.md section 5: dev sign-in, local photo storage, the fake AI provider, and
 * the fake eBay (in this process, with a token vault key of the stack's own), with the user's
 * eBay account connected through its consent page. Each stack has a scratch database on the
 * test cluster (`scripts/dev-db.sh`), a storage directory, and ports of its own, so it never
 * touches the developer's dev data or a running dev API. The worker never escalates on its own
 * (`AI_AUTO_ESCALATE=off`), so a test decides when "Identify harder" runs, and its operation
 * delays are a tenth of production's (`OPERATION_RETRY_DELAY_SCALE`), so an eBay change is
 * confirmed in seconds.
 */
export async function startLocalStack(options: LocalStackOptions): Promise<LocalStack> {
  const startTimeoutMs = options.startTimeoutMs ?? 30_000;
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
      consentRedirect: { acceptUrl: `${apiUrl}/v1/connections/ebay/callback` },
    });
    closers.push(() => fakeEbay.close());
    // Depop runs on the phone (docs/features/phone-execution.md): the app's phone runtime acts
    // on this fake Depop site in the simulator, through the stack's API.
    const fakeDepop = await FakeDepopSite.start();
    closers.push(() => fakeDepop.close());
    const shared = {
      PATH: process.env['PATH'],
      DATABASE_URL: database.scratch.url,
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
      TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
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

    const worker = startNodeProcess(WORKER_ENTRY, {
      ...shared,
      AI_AUTO_ESCALATE: 'off',
    });
    processes.push({ name: 'worker', process: worker });
    await worker.waitForLog((line) => line['msg'] === 'worker ready', startTimeoutMs);

    const accessToken = await signIn(api, apiUrl, E2E_EMAIL);
    await connectEbay({ apiUrl, accessToken }, fakeEbay);
    const control = await startStackControl({
      api: { apiUrl, accessToken },
      fakeEbay,
      fakeDepop,
      db: database.db,
    });
    closers.push(() => control.close());
    return {
      apiUrl,
      email: E2E_EMAIL,
      accessToken,
      controlUrl: control.url,
      fakeDepopUrl: fakeDepop.url,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
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
  stack: Pick<LocalStack, 'apiUrl' | 'accessToken' | 'email' | 'controlUrl' | 'fakeDepopUrl'>,
): Record<string, string> {
  const settings = {
    LISTORA_E2E_API_BASE_URL: stack.apiUrl,
    LISTORA_E2E_ACCESS_TOKEN: stack.accessToken,
    LISTORA_E2E_EMAIL: stack.email,
    LISTORA_E2E_CONTROL_URL: stack.controlUrl,
    LISTORA_E2E_FAKE_DEPOP_URL: stack.fakeDepopUrl,
  };
  // xcodebuild passes TEST_RUNNER_<name> to the test runner as <name>.
  const forwarded = Object.fromEntries(
    Object.entries(settings).map(([name, value]) => [`TEST_RUNNER_${name}`, value]),
  );
  return { ...settings, ...forwarded };
}
