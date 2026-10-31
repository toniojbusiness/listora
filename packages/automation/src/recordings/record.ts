/**
 * Records a marketplace's real pages (docs/features/recorded-pages.md):
 * `npm run recordings:record -- <depop|mercari|poshmark>` (in this package; `-- --help` for the
 * options). Development only: nothing in Listora runs it.
 *
 * It opens one background tab in a Chrome where the seller is signed in (remote debugging on,
 * `--remote-debugging-port=9333`), runs the marketplace's plan (plans.ts) there through the
 * session rules every run has (pacing, the read-only rule, the inspection after every action),
 * and writes each entry's recording, redacted (redact.ts), to the marketplace's `recordings/`
 * folder, with what changed since the committed one (diff.ts). With `--check` it writes
 * nothing and fails when a page changed: the check that a marketplace changed its pages.
 *
 * It never changes anything on the marketplace:
 * - read entries run as reads, which refuse form input and any step that changes something;
 * - form entries fill a form the way a create does, without photos, and stop before the step
 *   that sends it (any step that would change something is refused);
 * - a request that would send a file (a photo upload) is blocked before it leaves the browser
 *   (guard.ts); the page's own other traffic goes through, as when the seller browses by hand.
 * It is gentle: the marketplace's own pace between actions, at most one session every 10
 * minutes on Depop and Mercari, and it stops the whole session at the first check (a CAPTCHA,
 * a bot check, a sign-in or verification page), a rate limit, or a server error.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import type { Browser, BrowserContext, Page } from 'playwright-core';

import { createLogger, type Logger } from '@listora/shared';
import type { SessionCookie } from '@listora/connections';

import { BridgeBackend } from '../phone/backend.ts';
import { PlaywrightPhoneHost } from '../phone/test-host.ts';
import { NetworkLog } from '../runner/network-log.ts';
import { loadChromium } from '../runner/playwright.ts';
import { MemoryScreenshotStore } from '../runner/screenshots.ts';
import { ScriptSession } from '../runner/script-session.ts';
import { PlaywrightBackend } from '../runner/session.ts';
import type { Script, ScriptFailure, ScriptResult } from '../runner/types.ts';
import { Pacing } from '../safety/pacing.ts';
import { recordingChanges } from './diff.ts';
import { guardTab } from './guard.ts';
import {
  entryProfile,
  RECORDING_SKU,
  type RecordingPlan,
  type RecordingPlanEntry,
} from './plan.ts';
import { recordingPlan } from './plans.ts';
import {
  expandRecording,
  loadRecordings,
  RECORDED_MARKETPLACES,
  RECORDING_FORMAT,
  saveRecording,
  type ExpandedRecording,
  type RecordedMarketplace,
  type RecordingHost,
} from './recording.ts';
import { RecordingBackend } from './recording-backend.ts';
import { redactRecordings, unredacted } from './redact.ts';
import { failureSummary, recordedResult } from './result.ts';

const USAGE = `usage: npm run recordings:record -- <${RECORDED_MARKETPLACES.join('|')}> [options]

  --only <entry>   record only this plan entry (repeatable); the listing entries add "listings"
  --check          write nothing; exit 1 when a recorded page changed
  --cdp <url>      the signed-in Chrome's remote debugging address (default http://127.0.0.1:9333)
  --redact <word>  also redact this word wherever it appears (repeatable)
  --logged-out     record only the plan's logged-out entries (public pages), each in a fresh
                   browser context that holds no cookies; the seller's session is never used
`;

/** When each marketplace was last recorded, so the next session keeps its distance. */
const SESSIONS_DIR = fileURLToPath(new URL('../../../../.local/recordings/', import.meta.url));

/** The failures that end the whole session: the marketplace wants it to stop. */
const STOPS = new Set(['challenge', 'rate_limited', 'server_error']);

interface Options {
  marketplace: RecordedMarketplace;
  only: string[];
  check: boolean;
  cdp: string;
  redact: string[];
  loggedOut: boolean;
}

function parseOptions(argv: string[]): Options | null {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      only: { type: 'string', multiple: true, default: [] },
      check: { type: 'boolean', default: false },
      cdp: { type: 'string', default: 'http://127.0.0.1:9333' },
      redact: { type: 'string', multiple: true, default: [] },
      'logged-out': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  const marketplace = positionals[0];
  if (values.help || !(RECORDED_MARKETPLACES as readonly string[]).includes(marketplace ?? '')) {
    return null;
  }
  return {
    marketplace: marketplace as RecordedMarketplace,
    only: values.only,
    check: values.check,
    cdp: values.cdp,
    redact: values.redact,
    loggedOut: values['logged-out'],
  };
}

/** Whether the entry reads a public page, in a fresh browser context with no session. */
function loggedOut(entry: RecordingPlanEntry): boolean {
  return entry.session === 'logged_out';
}

/**
 * The entries to run, in plan order; an entry that reads a listing needs `listings` first. With
 * `--logged-out`, only the logged-out ones, and naming another is refused.
 */
function selected(
  plan: RecordingPlan,
  only: readonly string[],
  onlyLoggedOut: boolean,
): RecordingPlanEntry[] {
  if (onlyLoggedOut) {
    const entries = plan.entries.filter(
      (entry) => loggedOut(entry) && (only.length === 0 || only.includes(entry.name)),
    );
    const refused = only.filter((name) => !entries.some((entry) => entry.name === name));
    if (refused.length > 0) {
      throw new Error(`--logged-out records only logged-out entries, not ${refused.join(', ')}`);
    }
    if (entries.length === 0)
      throw new Error(`the ${plan.marketplace} plan has no logged-out entry`);
    return entries;
  }
  if (only.length === 0) return [...plan.entries];
  const names = new Set(only);
  for (const name of only) {
    const entry = plan.entries.find((candidate) => candidate.name === name);
    if (entry === undefined) throw new Error(`the ${plan.marketplace} plan has no entry ${name}`);
    if (entry.input !== undefined) names.add('listings');
  }
  return plan.entries.filter((entry) => names.has(entry.name));
}

/** Refuses a session sooner than the marketplace's gap after the last one, and notes this one. */
async function keepDistance(plan: RecordingPlan): Promise<void> {
  const file = `${SESSIONS_DIR}${plan.marketplace}.last`;
  const last = Number(await readFile(file, 'utf8').catch(() => '0'));
  const wait = last + plan.sessionGapMs - Date.now();
  if (wait > 0) {
    throw new Error(
      `the last ${plan.marketplace} recording session was less than ${String(plan.sessionGapMs / 60_000)} minutes ago; try again in ${String(Math.ceil(wait / 60_000))} minutes`,
    );
  }
  await mkdir(SESSIONS_DIR, { recursive: true });
  await writeFile(file, String(Date.now()));
}

async function record(options: Options): Promise<number> {
  const plan = recordingPlan(options.marketplace);
  const entries = selected(plan, options.only, options.loggedOut);
  const committed = await loadRecordings(plan.marketplace);
  await keepDistance(plan);
  const logger = createLogger({ service: 'recordings', level: 'warn' });
  const chromium = await loadChromium();
  const browser = await chromium.connectOverCDP(options.cdp);
  const recorded: ExpandedRecording[] = [];
  const privateTexts = new Set<string>();
  const blocked = new Map<string, number>();
  let stopped: string | null = null;
  try {
    const earlier = new Map<string, unknown>();
    for (const entry of entries) {
      const input = entry.input === undefined ? null : entry.input(earlier);
      if (input === undefined) {
        process.stdout.write(`${entry.name}: skipped (the seller has nothing for it)\n`);
        continue;
      }
      const { context, page, close } = loggedOut(entry)
        ? await freshTab(browser)
        : await sellerTab(browser);
      try {
        const tabBlocked = await guardTab(page);
        const { result, backend } = await recordEntry(plan, entry, input, context, page, logger);
        for (const [key, count] of tabBlocked) blocked.set(key, (blocked.get(key) ?? 0) + count);
        if (!result.ok && stopReason(result.failure) !== null) {
          stopped = `${entry.name} stopped at ${stopReason(result.failure) ?? ''} on ${where(page.url(), backend)}`;
          break;
        }
        for (const text of backend.privateTexts) privateTexts.add(text);
        if (result.ok) earlier.set(entry.name, result.value);
        recorded.push({
          format: RECORDING_FORMAT,
          marketplace: plan.marketplace,
          name: entry.name,
          page: entry.page,
          host: recordingHost(plan),
          recordedOn: new Date().toISOString().slice(0, 10),
          input,
          result: recordedResult(result),
          steps: result.steps,
          events: backend.events,
          states: backend.states,
          api: backend.api,
        });
        process.stdout.write(
          `${entry.name}: recorded (${result.ok ? 'ok' : `failed: ${JSON.stringify(failureSummary(result.failure))}`})\n`,
        );
      } finally {
        await close();
      }
    }
  } finally {
    // Disconnects only: the seller's Chrome keeps running.
    await browser.close();
  }
  return report(
    plan,
    { recorded, privateTexts: [...privateTexts] },
    committed,
    options,
    stopped,
    blocked,
  );
}

interface EntryTab {
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
}

/**
 * A tab of its own in the seller's session, as each run gets a fresh page: nothing one page left
 * (an unsaved form's leave prompt) holds up the next. In the background: the seller's own tabs
 * stay in front.
 */
async function sellerTab(browser: Browser): Promise<EntryTab> {
  const context = browser.contexts()[0];
  if (context === undefined) throw new Error('the Chrome has no browser window open');
  const cdp = await browser.newBrowserCDPSession();
  const { targetId } = await cdp.send('Target.createTarget', {
    url: 'about:blank',
    background: true,
  });
  // The tab this session made, by its target id: other sessions (other workers) open tabs in
  // the same Chrome at the same time, so the next new page may be theirs.
  const page = await ownTab(context, targetId);
  return {
    context,
    page,
    close: async () => {
      await cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);
      await cdp.detach().catch(() => undefined);
    },
  };
}

/**
 * A tab in a fresh browser context of its own, for a logged-out entry: it starts with no
 * cookies and no storage, so the page is what any visitor sees and no seller's session is ever
 * part of it. Refused if the context somehow holds a cookie.
 */
async function freshTab(browser: Browser): Promise<EntryTab> {
  const context = await browser.newContext();
  if ((await context.cookies()).length > 0) {
    await context.close();
    throw new Error('a fresh browser context held cookies; nothing was recorded');
  }
  const page = await context.newPage();
  return { context, page, close: () => context.close().catch(() => undefined) };
}

/** Runs one entry in its tab, through the recording backend. */
async function recordEntry(
  plan: RecordingPlan,
  entry: RecordingPlanEntry,
  input: unknown,
  context: BrowserContext,
  page: Page,
  logger: Logger,
): Promise<{ result: ScriptResult<unknown>; backend: RecordingBackend }> {
  const profile = entryProfile(plan, entry);
  // Through the backend of the host the marketplace runs on, so its selectors are read the way
  // they are in production (the phone's page functions, or the runner's Playwright).
  const inner =
    recordingHost(plan) === 'phone'
      ? new BridgeBackend(new PlaywrightPhoneHost(page))
      : new PlaywrightBackend(
          context,
          page,
          {
            profile,
            pacing: new Pacing(profile.pacing),
            screenshots: new MemoryScreenshotStore(),
            logger,
            stepTimeoutMs: plan.stepTimeoutMs,
            accountId: 'recording',
            runId: `${plan.marketplace}-${entry.name}`,
            network: new NetworkLog(),
            onClosed: () => undefined,
          },
          logger,
        );
  const backend = new RecordingBackend(inner, [
    ...profile.privateSelectors,
    ...plan.privateSelectors,
  ]);
  const session = new ScriptSession(backend, {
    profile,
    pacing: new Pacing(profile.pacing),
    logger,
    stepTimeoutMs: plan.stepTimeoutMs,
    close: () => Promise.resolve<SessionCookie[]>([]),
  });
  const script = guarded(entry.script(input));
  const signal = new AbortController().signal;
  const result =
    entry.mode === 'read'
      ? await session.read(entry.name, script, signal)
      : await session.run(entry.name, script, signal);
  await backend.capture();
  return { result, backend };
}

/** The host a marketplace's steps run on in production, whose page backend records it. */
function recordingHost(plan: RecordingPlan): RecordingHost {
  return plan.profile.runsOn === 'phone' ? 'phone' : 'runner';
}

/** Where a run stopped, for the seller to open: the page's path, and an API read it ended on. */
function where(url: string, backend: RecordingBackend): string {
  const path = URL.canParse(url) ? new URL(url).pathname : 'a page';
  const last = backend.api.at(-1);
  return last !== undefined && last.status >= 400
    ? `${path} (its web API answered ${String(last.status)})`
    : path;
}

/** The page of the tab with this target id, once the browser context has it. */
async function ownTab(context: BrowserContext, targetId: string): Promise<Page> {
  const end = Date.now() + 10_000;
  for (;;) {
    for (const page of context.pages()) {
      const session = await context.newCDPSession(page).catch(() => null);
      if (session === null) continue;
      const info = (await session.send('Target.getTargetInfo').catch(() => null)) as {
        targetInfo?: { targetId?: string };
      } | null;
      await session.detach().catch(() => undefined);
      if (info?.targetInfo?.targetId === targetId) return page;
    }
    if (Date.now() >= end) throw new Error('the new tab never showed up');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** The words of a form entry's sample listing: Listora's own, never redacted. */
function listingWords(entry: RecordingPlanEntry): string[] {
  const content = entry.content;
  if (content === undefined) return [];
  const { item, variant } = content;
  return [
    variant.title,
    variant.description,
    ...variant.hashtags,
    item.brand ?? '',
    item.productName ?? '',
    item.conditionNotes ?? '',
    RECORDING_SKU,
  ].filter((word) => word !== '');
}

/** The script, refused any step that would change something. */
function guarded(script: Script<unknown>): Script<unknown> {
  return (step) =>
    script((name, stepOptions, body) =>
      stepOptions.mutates
        ? Promise.reject(
            new Error(`a recording never runs a step that changes something (${name})`),
          )
        : step(name, stepOptions, body),
    );
}

function stopReason(failure: ScriptFailure): string | null {
  if (failure.kind === 'challenge') return `a check (${failure.challenge})`;
  if (failure.kind === 'error' && STOPS.has(failure.code))
    return `the marketplace's ${failure.code}`;
  return null;
}

async function report(
  plan: RecordingPlan,
  { recorded, privateTexts }: { recorded: readonly ExpandedRecording[]; privateTexts: string[] },
  committed: Awaited<ReturnType<typeof loadRecordings>>,
  options: Options,
  stopped: string | null,
  blocked: ReadonlyMap<string, number>,
): Promise<number> {
  const identity = [...plan.identity(recorded), ...options.redact];
  const keep = plan.entries.flatMap((entry) => listingWords(entry));
  const { recordings, report: replaced } = redactRecordings(recorded, {
    identity,
    privateTexts,
    keep,
  });
  process.stdout.write(`redacted: ${JSON.stringify(replaced)}\n`);
  if (blocked.size > 0) {
    process.stdout.write(`blocked requests: ${JSON.stringify(Object.fromEntries(blocked))}\n`);
  }
  let changed = false;
  for (const recording of recordings) {
    const problems = unredacted(recording, [...identity, ...privateTexts], keep);
    if (problems.length > 0) {
      process.stdout.write(
        `${recording.name}: NOT written, it still holds ${problems.join(', ')}\n`,
      );
      changed = true;
      continue;
    }
    const before = committed.get(recording.name);
    const changes = recordingChanges(
      before === undefined ? undefined : expandRecording(before),
      recording,
    );
    if (changes.length > 0) changed = true;
    for (const change of changes) process.stdout.write(`${recording.name}: ${change}\n`);
    if (!options.check)
      process.stdout.write(`${recording.name}: wrote ${await saveRecording(recording)}\n`);
  }
  if (stopped !== null) {
    process.stdout.write(`STOPPED: ${stopped}; nothing after it was recorded\n`);
    return 1;
  }
  return options.check && changed ? 1 : 0;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options === null) {
    process.stdout.write(USAGE);
    process.exitCode = 2;
    return;
  }
  process.exitCode = await record(options);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
