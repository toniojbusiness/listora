/**
 * Route discovery. Every folder of `src/` that serves `/v1` routes has a `feature.ts` that
 * exports `feature: ApiFeature`, and `buildApp` registers each one it finds, so a new feature
 * adds its own folder and never edits a shared list. The routes every deployment has whatever
 * its features (health probes, the auth driver's, the local storage driver's) stay in app.ts.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { AiClient } from '@listora/ai';
import type { PhoneWorkDependencies } from '@listora/automation';
import type { AnalysisJobQueue } from '@listora/analysis';
import type { BatchJobQueue } from '@listora/batches';
import type { KeyedSignals } from '@listora/db';
import type { PhotoJobQueue } from '@listora/photos';
import type { ObjectStorage } from '@listora/storage';
import type { FastifyInstance } from 'fastify';

import type { ConnectionsDependencies } from './connections/routes.ts';
import type { InvitesDependencies } from './invites/routes.ts';
import type { RouteDependencies } from './contract/routes.ts';
import type { MarketplaceSessionsDependencies } from './marketplace-sessions/routes.ts';
import type { PhotoUploads } from './photos/uploads.ts';
import type { SaleEmailsDependencies } from './sale-emails/routes.ts';
import type { EbayWebhookDependencies } from './webhooks/ebay.ts';

/** Everything a feature's routes may use, built once by `buildApp`. */
export interface ApiRouteContext extends RouteDependencies {
  /** Photo uploads and derived images. */
  storage: ObjectStorage;
  /** Where attached photo files come from. */
  uploads: PhotoUploads;
  /** Where `addItemPhoto` adds each new photo's processing job. */
  photoJobs: PhotoJobQueue;
  /**
   * The AI client: analysis requests are checked against its guards (the worker makes those
   * calls), and voice corrections call it.
   */
  ai: AiClient;
  /** Where starting or escalating an analysis adds its job. */
  analysisJobs: AnalysisJobQueue;
  /** Where submitting a batch item adds the job that starts its analysis. */
  batchJobs: BatchJobQueue;
  /** Marketplace adapters, OAuth clients, and the token sealer of connections. */
  connections: ConnectionsDependencies;
  /** The session vault and each marketplace's profile, for linking by signing in. */
  marketplaceSessions: MarketplaceSessionsDependencies;
  /** eBay's notification endpoint settings; the endpoint is not served without them. */
  ebayWebhook?: EbayWebhookDependencies;
  /** Email sale detection: the forwarding addresses' domain and the dev drop folder. */
  saleEmails: SaleEmailsDependencies;
  /** The sign-in provider's users that invitees sign in as. */
  invites: InvitesDependencies;
  /** The marketplace work phones run (docs/features/phone-execution.md); none without it. */
  phone: PhoneWorkDependencies | undefined;
  /** Signals keyed by item id, that end the item screen's wait for a change at once. */
  itemChanges: KeyedSignals | undefined;
  /** The clock upload sessions expire by. */
  now: () => Date;
}

/** What a feature's `feature.ts` exports as `feature`. */
export interface ApiFeature {
  registerRoutes: (app: FastifyInstance, context: ApiRouteContext) => void;
}

export interface DiscoveredApiFeature {
  /** The feature's folder under `src/`. */
  name: string;
  feature: ApiFeature;
}

const FEATURE_FILE = 'feature.ts';

/**
 * Imports `<folder>/feature.ts` from every folder of `srcDir`, in folder name order. A
 * `feature.ts` without an `ApiFeature` export is an error, so a feature can never be skipped
 * silently.
 */
export async function discoverApiFeatures(
  srcDir: string = import.meta.dirname,
): Promise<DiscoveredApiFeature[]> {
  const folders = readdirSync(srcDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(srcDir, entry.name, FEATURE_FILE)))
    .map((entry) => entry.name)
    .sort();
  const features: DiscoveredApiFeature[] = [];
  for (const name of folders) {
    const path = join(srcDir, name, FEATURE_FILE);
    const module = (await import(pathToFileURL(path).href)) as { feature?: Partial<ApiFeature> };
    if (typeof module.feature?.registerRoutes !== 'function') {
      throw new Error(`${path} must export \`feature\`, an ApiFeature with registerRoutes`);
    }
    features.push({ name, feature: module.feature as ApiFeature });
  }
  return features;
}

/** The features of this API, found once when the module loads. */
export const API_FEATURES: readonly DiscoveredApiFeature[] = await discoverApiFeatures();
