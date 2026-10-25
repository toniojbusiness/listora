import {
  accountConnections,
  completeAuthorization,
  findAuthorization,
  startAuthorization,
  type CompleteAuthorizationDependencies,
  type TokenSealer,
} from '@listora/connections';
import { MARKETPLACES, type Marketplace } from '@listora/db';
import {
  isMarketplace,
  MARKETPLACE_NAMES,
  type AdapterRegistry,
  type OAuthClients,
} from '@listora/marketplaces';
import type { FastifyInstance } from 'fastify';

import { operationSpec } from '../contract/contract.ts';
import { contractRoute, type RouteDependencies } from '../contract/routes.ts';
import { ApiError } from '../errors.ts';
import { APP_CALLBACK_SCHEME, authorizationView, connectionView } from './views.ts';

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
}

/**
 * Marketplace connections: `listConnections`, `getConnection`, `startConnectionAuthorization`,
 * `getConnectionAuthorization`, and the marketplace's OAuth redirect,
 * `handleConnectionCallback` (docs/features/marketplaces.md; the flow is in
 * `@listora/connections`).
 */
export function registerConnectionRoutes(
  app: FastifyInstance,
  deps: ConnectionRouteDependencies,
): void {
  const canConnect = (marketplace: Marketplace): boolean =>
    deps.oauth[marketplace] !== undefined && deps.sealer !== undefined;
  const context = () => ({ adapters: deps.adapters, canConnect, now: deps.now() });

  contractRoute(app, deps, 'listConnections', async ({ tenant, db }) => {
    const connections = await accountConnections(db, tenant.accountId);
    const viewContext = context();
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
    const connections = await accountConnections(db, tenant.accountId);
    return {
      status: 200,
      body: connectionView(params.marketplace, connections.get(params.marketplace), context()),
    };
  });

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
        const connections = await accountConnections(db, tenant.accountId);
        const found = connections.get(params.marketplace);
        if (found?.id === row.connection_id) {
          connection = connectionView(params.marketplace, found, context());
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
