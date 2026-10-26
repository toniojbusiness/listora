/**
 * The other marketplaces of the full local stack (`marketplaces: 'all'`), as a seller who uses
 * them all has them:
 *
 * - Depop through its Selling API (the fake Depop), bound to the stack's one Depop API
 *   connection. An API connection takes precedence over Depop automation, which the default
 *   stack's fake Depop site serves.
 * - Poshmark and Mercari (the fake Poshmark and the fake Mercari site) run on the seller's
 *   iPhone, where they run in production (docs/features/phone-execution.md): the app links them
 *   in Link accounts and its phone runtime acts on these fakes in the simulator.
 * - The stack's second seller has no eBay API connection: their eBay is automated in the cloud,
 *   in a session linked here (the fake eBay site, driven by the browser runner the worker
 *   starts), the one marketplace whose automation runs in the cloud.
 *
 * Automation runs at the fastest pace the safety rules allow (`PACING_FLOOR`) and the most runs
 * they allow (`LIMITS_CEILING`), so a listing takes seconds, not minutes, and stays well inside
 * what a person would do.
 */
import { randomBytes } from 'node:crypto';

import {
  FakeEbaySite,
  FakeMercariSite,
  FakePoshmark,
  LIMITS_CEILING,
  linkAutomationSession,
  loadAutomationSettings,
  PACING_FLOOR,
} from '@listora/automation';
import { LocalTokenVault, SessionVault } from '@listora/connections';
import type { Db } from '@listora/db';
import { FakeDepop } from '@listora/marketplaces';
import { createLogger } from '@listora/shared';

export interface MarketplaceFakes {
  /** The Depop Selling API. */
  readonly depop: FakeDepop;
  readonly poshmark: FakePoshmark;
  readonly mercari: FakeMercariSite;
  /** eBay's website, which the second seller's eBay automation acts on. */
  readonly ebaySite: FakeEbaySite;
  /** What the API and the worker need to use them (the Depop connection comes later). */
  readonly env: Readonly<Record<string, string>>;
  close(): Promise<void>;
}

export async function startMarketplaceFakes(): Promise<MarketplaceFakes> {
  const started: { close(): Promise<void> }[] = [];
  try {
    // Local storage serves photos over http, which only a development fake Depop accepts.
    const depop = await FakeDepop.start({ allowHttpPictures: true });
    started.push(depop);
    const poshmark = await FakePoshmark.start();
    started.push(poshmark);
    const mercari = await FakeMercariSite.start();
    started.push(mercari);
    const ebaySite = await FakeEbaySite.start();
    started.push(ebaySite);
    return {
      depop,
      poshmark,
      mercari,
      ebaySite,
      env: {
        DEPOP_ENV: 'fake',
        DEPOP_FAKE_URL: depop.url,
        FAKE_POSHMARK_URL: poshmark.url,
        FAKE_MERCARI_SITE_URL: mercari.url,
        FAKE_EBAY_SITE_URL: ebaySite.url,
        ...automationPace(),
      },
      close: async () => {
        for (const fake of started.toReversed()) await fake.close();
      },
    };
  } catch (error) {
    for (const fake of started.toReversed()) await fake.close();
    throw error;
  }
}

/** The pacing floor and the run ceiling for every automated marketplace. */
function automationPace(): Record<string, string> {
  const range = ([min, max]: readonly [number, number]) => `${String(min)}-${String(max)}`;
  return Object.fromEntries(
    (['POSHMARK', 'MERCARI', 'DEPOP', 'EBAY'] as const).flatMap((name) => [
      [`AUTOMATION_${name}_PACE_MS`, range(PACING_FLOOR.actionDelayMs)],
      [`AUTOMATION_${name}_SESSION_GAP_MS`, range(PACING_FLOOR.sessionGapMs)],
      [`AUTOMATION_${name}_RUNS_PER_HOUR`, String(LIMITS_CEILING.runsPerHour)],
      [`AUTOMATION_${name}_RUNS_PER_DAY`, String(LIMITS_CEILING.runsPerDay)],
    ]),
  );
}

/** The eBay notification settings: the fake eBay delivers its events to the stack's API. */
export function ebayNotificationEnv(apiUrl: string): Record<string, string> {
  return {
    EBAY_NOTIFICATION_ENDPOINT: `${apiUrl}/webhooks/ebay`,
    // 32 to 80 letters and digits; a fresh one per stack, though the fake needs no secret.
    EBAY_NOTIFICATION_VERIFICATION_TOKEN: randomBytes(24).toString('hex'),
    EBAY_NOTIFICATION_ALERT_EMAIL: 'alerts@listora.test',
  };
}

/**
 * The seller's Depop API connection, bound to the fake Depop's development seller: what Depop
 * connect (T-24) will create, and what `DEPOP_USER_CONNECTION_ID` names until then.
 */
export async function insertDepopConnection(
  db: Db,
  accountId: string,
  depop: FakeDepop,
): Promise<string> {
  const row = await db
    .insertInto('marketplace_connection')
    .values({
      account_id: accountId,
      marketplace: 'depop',
      mode: 'api',
      external_user_id: String(depop.developmentSellerId),
      display_name: 'listora_dev_seller',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/**
 * Links the second seller's eBay session for cloud automation, as the app's linking does
 * (`linkAutomationSession`): with the cookie the fake eBay site issues a signed-in seller, sealed
 * with the stack's token key, for the profile the worker and the runner use. eBay runs in the
 * cloud by default, so no phone is involved.
 */
export class EbaySessionLinker {
  readonly #db: Db;
  readonly #vault: SessionVault;
  readonly #settings: ReturnType<typeof loadAutomationSettings>;
  readonly #site: FakeEbaySite;

  constructor(options: {
    db: Db;
    tokenKey: Buffer;
    /** The worker's environment, which decides eBay's profile. */
    workerEnv: NodeJS.ProcessEnv;
    site: FakeEbaySite;
  }) {
    this.#db = options.db;
    this.#vault = new SessionVault({
      vault: new LocalTokenVault(options.tokenKey),
      logger: createLogger({ service: 'e2e-stack', level: 'silent' }),
    });
    this.#settings = loadAutomationSettings(options.workerEnv);
    this.#site = options.site;
  }

  /** Links (or relinks) a fresh session; returns the connection's id. */
  async link(accountId: string): Promise<string> {
    const { connectionId } = await linkAutomationSession(
      this.#db,
      { vault: this.#vault, profile: this.#settings.profiles.ebay },
      { accountId, marketplace: 'ebay', cookies: [this.#site.issueSession()] },
    );
    return connectionId;
  }
}
