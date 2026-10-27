import {
  createAiClient,
  PostgresAiControls,
  PostgresQuotaPolicy,
  PostgresUsageStore,
} from '@listora/ai';
import { graphileAnalysisJobs } from '@listora/analysis';
import { phoneWorkAdapters } from '@listora/automation';
import { createOAuthClients, createTokenVault, sealOnly, SessionVault } from '@listora/connections';
import { addJob, createDatabase, createPool } from '@listora/db';
import {
  ApplicationToken,
  createMarketplaceAdapters,
  EbayNotificationVerifier,
  EbayOAuthClient,
} from '@listora/marketplaces';
import { scaledRetryPolicy } from '@listora/operations';
import { graphilePhotoJobs } from '@listora/photos';
import { ebaySellerSubscriptionsJob } from '@listora/sales';
import { createLogger, handleShutdownSignals } from '@listora/shared';
import { createStorage } from '@listora/storage';

import { buildApp } from './app.ts';
import { createAuthDriver } from './auth/create-driver.ts';
import { loadApiConfig } from './config.ts';
import { pingDatabase } from './db.ts';
import { createInviteeDirectory } from './invites/create-directory.ts';

/** How long a stopping API task on ECS keeps serving (within the task's 30 s stop timeout). */
const SHUTDOWN_DRAIN_MS = 10_000;

const config = loadApiConfig();
const logger = createLogger({ service: 'api', level: config.logLevel });
const pool = createPool({ connectionString: config.databaseUrl });
const db = createDatabase(pool);

const ebay = config.marketplaces.ebay;
const ebayNotifications = ebay?.notifications;
// The API only seals with it: new grants and linked sessions. The worker and the runner open them.
const tokenVault =
  config.marketplaces.tokenVault === undefined
    ? undefined
    : createTokenVault(config.marketplaces.tokenVault);

const sessionVault =
  tokenVault === undefined ? undefined : new SessionVault({ vault: tokenVault, logger });

const app = buildApp({
  logger,
  db,
  auth: createAuthDriver(config.auth, logger),
  signUp: config.signUp,
  invites: { directory: createInviteeDirectory(config) },
  storage: createStorage(config.storage),
  photoJobs: graphilePhotoJobs,
  ai: createAiClient(config.ai, {
    usageStore: new PostgresUsageStore(db),
    controls: new PostgresAiControls(db),
    quota: new PostgresQuotaPolicy(db),
    logger,
  }),
  analysisJobs: graphileAnalysisJobs,
  connections: {
    adapters: createMarketplaceAdapters(config.marketplaces),
    oauth: createOAuthClients(config.marketplaces),
    // The API only seals new grants; the worker opens them at use time.
    sealer: tokenVault === undefined ? undefined : sealOnly(tokenVault),
    // A new eBay grant subscribes its seller's notifications (the worker runs the job).
    ...(ebayNotifications === undefined
      ? {}
      : {
          onConnected: async (trx, connection) => {
            if (connection.marketplace === 'ebay') {
              await addJob(trx, ebaySellerSubscriptionsJob(connection.id));
            }
          },
        }),
  },
  ...(ebay === undefined || ebayNotifications === undefined
    ? {}
    : {
        ebayWebhook: {
          verifier: new EbayNotificationVerifier({
            endpoints: ebay.endpoints,
            token: new ApplicationToken(
              new EbayOAuthClient({
                tokenUrl: ebay.endpoints.oauthToken,
                clientId: ebay.clientId,
                clientSecret: ebay.clientSecret,
              }),
            ),
          }),
          endpoint: ebayNotifications.endpoint,
          verificationToken: ebayNotifications.verificationToken,
        },
      }),
  // Linked sessions are sealed with the same vault; only the browser runner opens them.
  marketplaceSessions: { vault: sessionVault, profiles: config.automation.profiles },
  // The marketplace work phones run (docs/features/phone-execution.md): the API runs each step
  // with the phone's answers, under the same retry policy as the worker.
  phone: {
    db,
    adapters: phoneWorkAdapters(config.automation, config.marketplaces, logger),
    profiles: config.automation.profiles,
    ...(sessionVault === undefined ? {} : { vault: sessionVault }),
    policy: scaledRetryPolicy(config.operationRetryDelayScale),
    saleChecks: config.automation.saleChecks,
    logger,
    stepTimeoutMs: config.automation.stepTimeoutMs,
    callTimeoutMs: config.automation.callTimeoutMs,
    blockedRecheckMs: 5 * 60_000,
  },
  saleEmails: { ingest: config.emailIngest },
  pingDatabase: () => pingDatabase(pool),
});

// SIGTERM (ECS) or SIGINT: stop accepting connections, let in-flight requests finish, then
// close the database pool. On ECS the API first keeps serving for a moment: the HTTP API's VPC
// link finds out from Cloud Map that a stopping task is gone only after ECS deregistered it, so
// closing at once refuses the requests still routed here (5 gateway 5xx in one rolling deploy,
// 2026-10-27).
const drainMs = process.env['ECS_CONTAINER_METADATA_URI_V4'] === undefined ? 0 : SHUTDOWN_DRAIN_MS;
handleShutdownSignals({
  logger,
  timeoutMs: drainMs + 10_000,
  shutdown: async () => {
    if (drainMs > 0) await new Promise((resolve) => setTimeout(resolve, drainMs));
    await app.close();
    await db.destroy();
  },
});

await app.listen({ host: config.host, port: config.port });
