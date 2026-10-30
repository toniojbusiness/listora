import {
  cloudAccess,
  requestSessionRecheck,
  setExecutionLocation,
  type AutomatedMarketplace,
  type AutomationProfile,
} from '@listora/automation';
import {
  accountConnections,
  accountExecutionState,
  accountSessionChecks,
  completeAuthorization,
  CONNECTION_CHECK_TASK,
  findAuthorization,
  requestHealthCheck,
  startAuthorization,
  startConnectionDeletion,
  type CompleteAuthorizationDependencies,
  type ConnectionRow,
  type ExecutionState,
  type SessionCheckState,
  type TokenSealer,
} from '@listora/connections';
import {
  addJob,
  inTransaction,
  MARKETPLACES,
  type DbExecutor,
  type DbTransaction,
  type Marketplace,
} from '@listora/db';
import { findSaleEmailInbox, inboundDomainOf } from '@listora/email-sales';
import {
  ProtectedShopError,
  readOnlyUnlinkMessage,
  setConnectionReadOnly,
} from '@listora/operations';
import {
  isMarketplace,
  MARKETPLACE_NAMES,
  type AdapterRegistry,
  type OAuthClients,
} from '@listora/marketplaces';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';

import { operationSpec } from '../contract/contract.ts';
import { writeAudit } from '../audit.ts';
import { contractRoute, type RouteDependencies } from '../contract/routes.ts';
import { isPgError, PG_ERROR } from '../db-errors.ts';
import { ApiError } from '../errors.ts';
import type { SaleEmailsDependencies } from '../sale-emails/routes.ts';
import { saleForwardingView } from '../sale-emails/views.ts';
import {
  APP_CALLBACK_SCHEME,
  authorizationView,
  connectionHealthView,
  connectionView,
  type SaleCheckState,
} from './views.ts';

export interface ConnectionsDependencies {
  /** The same adapters the worker runs with: each marketplace's capabilities. */
  adapters: AdapterRegistry;
  /** The marketplaces this API can connect. */
  oauth: OAuthClients;
  /**
   * Seals the tokens of a new grant. The API cannot decrypt them: only the worker opens them,
   * at use time. Undefined without a token vault; then nothing can be connected.
   */
  sealer: TokenSealer | undefined;
  /** Work that starts with a stored grant, in its transaction (`completeAuthorization`). */
  onConnected?: CompleteAuthorizationDependencies['onConnected'];
}

export interface ConnectionRouteDependencies extends RouteDependencies, ConnectionsDependencies {
  now: () => Date;
  /** Each automated marketplace's profile: whether it may run in Listora's cloud. */
  marketplaceSessions: { profiles: Readonly<Record<AutomatedMarketplace, AutomationProfile>> };
  /** Sale email forwarding, which the health summary reports on. */
  saleEmails: SaleEmailsDependencies;
}

/**
 * Marketplace connections: `listConnections`, `getConnection`, the health summary
 * `getConnectionHealth`, `requestConnectionCheck` (Retry check), `disconnectConnection` (unlink),
 * `startConnectionAuthorization`,
 * `getConnectionAuthorization`, and the marketplace's OAuth redirect,
 * `handleConnectionCallback` (docs/features/connections.md; the flow is in
 * `@listora/connections`). An automation connection is shown as its linked session's check says
 * (`describeAutomationSession`), the same way Link accounts shows it.
 */
export function registerConnectionRoutes(
  app: FastifyInstance,
  deps: ConnectionRouteDependencies,
): void {
  const canConnect = (marketplace: Marketplace): boolean =>
    deps.oauth[marketplace] !== undefined && deps.sealer !== undefined;
  const cloudAccessOf = (marketplace: Marketplace) =>
    cloudAccess(deps.marketplaceSessions.profiles, marketplace);
  const context = (
    state: {
      sessionChecks: ReadonlyMap<string, SessionCheckState>;
      saleChecks: ReadonlyMap<string, SaleCheckState>;
      execution: ExecutionState;
    },
    now = deps.now(),
  ) => ({
    adapters: deps.adapters,
    canConnect,
    sessionChecks: state.sessionChecks,
    saleChecks: state.saleChecks,
    execution: state.execution,
    cloudAccess: cloudAccessOf,
    now,
  });

  contractRoute(app, deps, 'listConnections', async ({ tenant, db }) => {
    const state = await accountState(db, tenant.accountId);
    const { connections } = state;
    const viewContext = context(state);
    return {
      status: 200,
      body: {
        data: MARKETPLACES.map((marketplace) =>
          connectionView(marketplace, connections.get(marketplace), viewContext),
        ),
      },
    };
  });

  contractRoute(app, deps, 'getConnection', async ({ tenant, db, params }) => {
    const state = await accountState(db, tenant.accountId);
    return {
      status: 200,
      body: connectionView(
        params.marketplace,
        state.connections.get(params.marketplace),
        context(state),
      ),
    };
  });

  const inboundDomain = inboundDomainOf(deps.saleEmails.ingest);

  /**
   * Unlinking: deletes the connection and every piece of the marketplace's data in the account
   * at once (`startConnectionDeletion`: its listings, sales, offers, tasks, and the items only
   * its import brought in), and leaves the job that asks the marketplace to revoke the grant,
   * deletes the stored objects, and records the checked deletion (docs/features/privacy.md).
   * Nothing changes on the marketplace: its listings stay up there. A read-only connection is
   * never unlinked: the owner turns Read only off first, so an unlink and a relink are never a
   * way around it (docs/features/read-only.md#unlinking-and-relinking).
   */
  contractRoute(app, deps, 'disconnectConnection', async ({ tenant, db, params, request }) => {
    const connection = (await accountConnections(db, tenant.accountId)).get(params.marketplace);
    const started =
      connection === undefined
        ? undefined
        : await againOnDeadlock(db, request.log, async (trx) => {
            // Under the row's lock, so a setting changed meanwhile is the one that counts.
            const current = await trx
              .selectFrom('marketplace_connection')
              .select('read_only')
              .where('account_id', '=', tenant.accountId)
              .where('id', '=', connection.id)
              .forUpdate()
              .executeTakeFirst();
            if (current?.read_only === true) {
              throw new ApiError('connection_read_only', readOnlyUnlinkMessage(params.marketplace));
            }
            return startConnectionDeletion(trx, {
              accountId: tenant.accountId,
              connectionId: connection.id,
              reason: 'unlinked',
            });
          });
    if (started === undefined) {
      throw new ApiError(
        'not_found',
        `No ${MARKETPLACE_NAMES[params.marketplace]} account is linked to Listora.`,
      );
    }
    request.log.info(
      {
        connectionDeletionId: started.deletionId,
        marketplace: params.marketplace,
        listings: started.deleted.listings,
        items: started.deleted.marketplaceData?.items ?? 0,
        sales: started.deleted.marketplaceData?.sales ?? 0,
        tasks: started.deleted.marketplaceData?.tasks ?? 0,
        settledOperations: started.deleted.marketplaceData?.settledOperations ?? 0,
        inboundEvents: started.deleted.inboundEvents,
        automationRuns: started.deleted.automationRuns,
        revokeGrant: started.deleted.grantCiphertext !== null,
      },
      'marketplace connection unlinked; its data was deleted',
    );
    const state = await accountState(db, tenant.accountId);
    return {
      status: 200,
      body: connectionView(params.marketplace, undefined, context(state)),
    };
  });

  contractRoute(app, deps, 'getConnectionHealth', async ({ tenant, db }) => {
    const state = await accountState(db, tenant.accountId);
    const inbox = await findSaleEmailInbox(db, tenant.accountId);
    return {
      status: 200,
      body: {
        ...connectionHealthView(state.connections, context(state)),
        saleForwarding: saleForwardingView(inbox, inboundDomain),
      },
    };
  });

  // The worker checks with the settings the API connects with, so `canConnect` decides both.
  // An automation connection's check is the browser runner's session check instead.
  contractRoute(app, deps, 'requestConnectionCheck', async ({ tenant, db, params }) => {
    const name = MARKETPLACE_NAMES[params.marketplace];
    const now = deps.now();
    const linked = (await accountConnections(db, tenant.accountId)).get(params.marketplace);
    if (linked?.mode === 'automation') {
      const requested = await requestSessionRecheck(
        db,
        { accountId: tenant.accountId, connectionId: linked.id },
        now,
      );
      if (!requested) {
        throw new ApiError(
          'invalid_state_transition',
          `Listora has no ${name} sign-in to check. Link ${name} again.`,
        );
      }
      const state = await accountState(db, tenant.accountId);
      return {
        status: 202,
        body: connectionView(
          params.marketplace,
          state.connections.get(params.marketplace),
          context(state, now),
        ),
      };
    }
    if (!canConnect(params.marketplace)) {
      throw new ApiError(
        'marketplace_action_unavailable',
        `Listora can't check ${name} connections yet.`,
      );
    }
    const connection = linked;
    if (connection === undefined || !(await requestHealthCheck(db, connection.id, now))) {
      throw new ApiError(
        'invalid_state_transition',
        connection?.mode !== 'api'
          ? `Connect ${name} first.`
          : `Listora can't check this ${name} connection. Reconnect ${name}.`,
      );
    }
    await addJob(db, {
      task: CONNECTION_CHECK_TASK,
      payload: { connectionId: connection.id },
      jobKey: `connection_check:${connection.id}`,
    });
    const state = await accountState(db, tenant.accountId);
    return {
      status: 202,
      body: connectionView(
        params.marketplace,
        state.connections.get(params.marketplace),
        context(state, now),
      ),
    };
  });

  // Where the connection's automated steps run: the cloud runner, or the phone that linked it.
  contractRoute(app, deps, 'setConnectionExecution', async ({ tenant, db, params, body }) => {
    const name = MARKETPLACE_NAMES[params.marketplace];
    const linked = (await accountConnections(db, tenant.accountId)).get(params.marketplace);
    if (linked?.mode !== 'automation') {
      throw new ApiError(
        'invalid_state_transition',
        `${name} isn't linked by signing in, so there is nothing to run on your iPhone.`,
      );
    }
    const cloud = cloudAccessOf(params.marketplace);
    if (body.location === 'cloud' && !cloud.allowed) {
      throw new ApiError('marketplace_action_unavailable', `${cloud.reason}.`);
    }
    await setExecutionLocation(
      db,
      { accountId: tenant.accountId, connectionId: linked.id },
      body.location,
    );
    const state = await accountState(db, tenant.accountId);
    return {
      status: 200,
      body: connectionView(
        params.marketplace,
        state.connections.get(params.marketplace),
        context(state),
      ),
    };
  });

  contractRoute(
    app,
    deps,
    'setConnectionReadOnly',
    async ({ tenant, db, params, body, request }) => {
      const name = MARKETPLACE_NAMES[params.marketplace];
      if (tenant.role !== 'owner') {
        throw new ApiError(
          'forbidden',
          `Only the account's owner can change whether Listora may change your ${name} account.`,
        );
      }
      const linked = (await accountConnections(db, tenant.accountId)).get(params.marketplace);
      const changed =
        linked === undefined
          ? undefined
          : await inTransaction(db, async (trx) => {
              const result = await setConnectionReadOnly(
                trx,
                { accountId: tenant.accountId, connectionId: linked.id },
                body.readOnly,
              ).catch((error: unknown) => {
                // A protected shop stays read only (docs/features/read-only.md#protected-shops).
                if (error instanceof ProtectedShopError) {
                  throw new ApiError('connection_read_only', error.message);
                }
                throw error;
              });
              if (result !== undefined) {
                await writeAudit(trx, tenant, {
                  action: 'connection.read_only_changed',
                  changes: {
                    marketplace: params.marketplace,
                    readOnly: { from: linked.read_only, to: body.readOnly },
                    refusedOperations: result.refused.length,
                  },
                });
              }
              return result;
            });
      if (changed === undefined) {
        throw new ApiError('not_found', `No ${name} account is linked to Listora.`);
      }
      request.log.info(
        {
          marketplace: params.marketplace,
          readOnly: body.readOnly,
          refusedOperations: changed.refused.length,
        },
        'marketplace connection read-only setting changed',
      );
      const state = await accountState(db, tenant.accountId);
      return {
        status: 200,
        body: connectionView(
          params.marketplace,
          state.connections.get(params.marketplace),
          context(state),
        ),
      };
    },
  );

  contractRoute(
    app,
    deps,
    'startConnectionAuthorization',
    async ({ tenant, db, params, request }) => {
      const oauth = deps.oauth[params.marketplace];
      if (oauth === undefined || deps.sealer === undefined) {
        const name = MARKETPLACE_NAMES[params.marketplace];
        const capabilities = deps.adapters.capabilities(params.marketplace, null);
        const assisted =
          oauth === undefined &&
          capabilities !== undefined &&
          capabilities.connect !== 'oauth' &&
          capabilities.verifyRead !== 'api';
        throw new ApiError(
          'marketplace_action_unavailable',
          assisted
            ? `${name} has no account connection in Listora yet; Listora works with ${name} in assisted mode.`
            : `Listora can't connect ${name} accounts yet.`,
        );
      }
      const now = deps.now();
      const started = await startAuthorization(db, oauth, {
        accountId: tenant.accountId,
        userId: tenant.userId,
        now,
      });
      return {
        status: 201,
        body: authorizationView(started.authorization, {
          now,
          requestId: request.id,
          authorizationUrl: started.authorizationUrl,
        }),
      };
    },
  );

  contractRoute(
    app,
    deps,
    'getConnectionAuthorization',
    async ({ tenant, db, params, request }) => {
      const row = await findAuthorization(
        db,
        tenant.accountId,
        params.marketplace,
        params.authorizationId,
      );
      if (row === undefined) {
        throw new ApiError('not_found', 'This connection attempt was not found.');
      }
      const now = deps.now();
      let connection;
      if (row.status === 'completed' && row.connection_id !== null) {
        const state = await accountState(db, tenant.accountId);
        const found = state.connections.get(params.marketplace);
        if (found?.id === row.connection_id) {
          connection = connectionView(params.marketplace, found, context(state, now));
        }
      }
      return {
        status: 200,
        body: authorizationView(row, {
          now,
          requestId: request.id,
          ...(connection === undefined ? {} : { connection }),
        }),
      };
    },
  );

  registerCallback(app, deps);
}

/** The account's connections and their session checks, read together for the views. */
async function accountState(
  db: DbExecutor,
  accountId: string,
): Promise<{
  connections: Map<Marketplace, ConnectionRow>;
  sessionChecks: Map<string, SessionCheckState>;
  saleChecks: Map<string, SaleCheckState>;
  execution: ExecutionState;
}> {
  const connections = await accountConnections(db, accountId);
  return {
    connections,
    sessionChecks: await accountSessionChecks(db, accountId),
    saleChecks: await accountSaleChecks(db, accountId),
    execution: await accountExecutionState(db, accountId),
  };
}

/** The account's sale-check schedules by connection id (docs/features/activity.md). */
async function accountSaleChecks(
  db: DbExecutor,
  accountId: string,
): Promise<Map<string, SaleCheckState>> {
  const rows = await db
    .selectFrom('sale_check_schedule')
    .select([
      'connection_id',
      'health',
      'last_finished_at',
      'last_succeeded_at',
      'next_check_at',
      'last_error_code',
      'last_error_message',
    ])
    .where('account_id', '=', accountId)
    .execute();
  return new Map(
    rows.map((row) => [
      row.connection_id,
      {
        health: row.health,
        lastCheckedAt: row.last_finished_at,
        lastSucceededAt: row.last_succeeded_at,
        nextCheckAt: row.next_check_at,
        lastError:
          row.last_error_code === null || row.last_error_message === null
            ? null
            : { code: row.last_error_code, message: row.last_error_message },
      },
    ]),
  );
}

/**
 * `handleConnectionCallback`: the marketplace's redirect after consent. It is public (the
 * single-use `state` is its only credential) and always answers with a redirect to the app,
 * whatever happened, so `ASWebAuthenticationSession` returns and the app reads the attempt's
 * result. The URL carries the authorization code, so the answer is never cached and sends no
 * referrer.
 */
function registerCallback(app: FastifyInstance, deps: ConnectionRouteDependencies): void {
  const spec = operationSpec('handleConnectionCallback');
  app.route({
    method: spec.method,
    url: spec.url,
    // The query holds the authorization code and state: request log lines show the path only.
    childLoggerFactory: (logger, bindings, options) =>
      logger.child(bindings, {
        ...options,
        serializers: {
          ...options.serializers,
          req: (request: { method?: string; url?: string }) => ({
            method: request.method,
            url: request.url?.split('?')[0],
          }),
        },
      }),
    handler: async (request, reply) => {
      const { marketplace } = request.params as { marketplace?: string };
      const known =
        marketplace !== undefined && isMarketplace(marketplace) ? marketplace : undefined;
      let authorizationId: string | undefined;
      const query = spec.validateQuery(request.query);
      if (known !== undefined && query.ok) {
        const values = (query.value ?? {}) as {
          state?: string;
          code?: string;
          error?: string;
        };
        try {
          const settled = await completeAuthorization(
            {
              db: deps.db,
              oauth: deps.oauth,
              sealer: deps.sealer,
              logger: request.log,
              now: deps.now,
              ...(deps.onConnected === undefined ? {} : { onConnected: deps.onConnected }),
            },
            { marketplace: known, state: values.state, code: values.code, error: values.error },
          );
          authorizationId = settled?.id;
        } catch (error) {
          request.log.error({ err: error }, 'the marketplace connection callback failed');
        }
      } else {
        request.log.warn(
          { marketplace: known ?? 'unknown' },
          'marketplace connection callback without a valid state',
        );
      }
      const target = new URL(`${APP_CALLBACK_SCHEME}://connections/${known ?? 'unknown'}`);
      if (authorizationId !== undefined)
        target.searchParams.set('authorizationId', authorizationId);
      return reply
        .code(302)
        .header('location', target.toString())
        .header('cache-control', 'no-store')
        .header('referrer-policy', 'no-referrer')
        .send();
    },
  });
}

/** How many times an unlink runs before a deadlock fails it. */
const UNLINK_ATTEMPTS = 3;

/**
 * Runs the unlink's transaction, again when Postgres rolled it back to break a deadlock. Work on
 * the connection locks it first (`lockConnections`), so an unlink waits for it instead; this
 * keeps the unlink completing even next to work that does not (logged, to be fixed), since a
 * deadlock's victim is rolled back whole and safe to run again.
 */
async function againOnDeadlock<T>(
  db: DbExecutor,
  log: Pick<FastifyBaseLogger, 'warn'>,
  work: (trx: DbTransaction) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await inTransaction(db, work);
    } catch (error) {
      // Inside a caller's transaction, the whole of it was rolled back: only the caller can retry.
      if (
        db.isTransaction ||
        attempt >= UNLINK_ATTEMPTS ||
        !isPgError(error, PG_ERROR.deadlockDetected)
      ) {
        throw error;
      }
      log.warn({ err: error, attempt }, 'unlink deadlocked with work on the connection; again');
    }
  }
}
