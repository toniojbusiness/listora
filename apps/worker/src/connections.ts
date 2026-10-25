import {
  CONNECTION_CHECK_TASK,
  CONNECTION_HEALTH_SCHEDULE,
  CONNECTION_HEALTH_TASK,
  ConnectionSeller,
  ConnectionTokens,
  OAuthGrantRevoker,
  runConnectionHealthChecks,
  runRequestedHealthCheck,
  type TokenVault,
} from '@listora/connections';
import type { Db } from '@listora/db';
import type { EbayConfig, EbaySellerSource, OAuthClients } from '@listora/marketplaces';
import type { ScheduledTask, WorkerTask } from '@listora/operations';
import type { Logger } from '@listora/shared';

export interface ConnectionWorkDependencies {
  db: Db;
  /** The token vault; undefined when the worker has none (nothing can be connected then). */
  vault: TokenVault | undefined;
  oauth: OAuthClients;
  /** The eBay adapter's settings (its listing defaults go with each connection's tokens). */
  ebay: EbayConfig | undefined;
  logger: Logger;
}

/** What the worker does with marketplace connections, when it has a vault to open tokens. */
export interface ConnectionWork {
  /** Use-time access to every connection's tokens; undefined without a vault. */
  tokens: ConnectionTokens | undefined;
  /** Each eBay connection's own tokens for the eBay adapter (single-flight refresh). */
  ebaySeller: EbaySellerSource | undefined;
  /** The daily health check. */
  scheduledTasks: ScheduledTask[];
  /** The check one seller asked for ("Retry check", `connection_health_check`). */
  tasks: Record<string, WorkerTask>;
  /** Revokes a deleted account's grants through the marketplace (account deletion job). */
  revoker: OAuthGrantRevoker | undefined;
}

/**
 * The worker's side of marketplace connections (docs/features/connections.md): the eBay
 * adapter's per-connection tokens, the daily `connection_health` check and the
 * `connection_health_check` the seller asks for, and the revocations
 * account deletion asks for. Without a vault none of them can open a token, so none runs, and
 * the eBay adapter keeps its configured development seller (`EBAY_USER_*`), if any.
 */
export function createConnectionWork(deps: ConnectionWorkDependencies): ConnectionWork {
  const { vault, oauth, db, logger, ebay } = deps;
  if (vault === undefined || Object.keys(oauth).length === 0) {
    return {
      tokens: undefined,
      ebaySeller: undefined,
      scheduledTasks: [],
      tasks: {},
      revoker: undefined,
    };
  }
  const tokens = new ConnectionTokens({ db, vault, oauth, logger });
  return {
    tokens,
    ebaySeller:
      ebay === undefined || oauth.ebay === undefined
        ? undefined
        : new ConnectionSeller({ tokens, listingSettings: ebay.listingSettings }),
    scheduledTasks: [
      {
        name: CONNECTION_HEALTH_TASK,
        schedule: CONNECTION_HEALTH_SCHEDULE,
        // A failed run is not retried; the next day's check covers it.
        maxAttempts: 1,
        run: async (signal) => {
          await runConnectionHealthChecks({ db, tokens, oauth, logger }, signal);
        },
      },
    ],
    tasks: {
      [CONNECTION_CHECK_TASK]: async (payload) => {
        await runRequestedHealthCheck({ db, tokens, oauth, logger }, payload);
      },
    },
    revoker: new OAuthGrantRevoker({ vault, oauth, logger }),
  };
}
