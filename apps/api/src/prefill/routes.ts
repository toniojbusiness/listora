/**
 * The marketplace pre-fill (docs/features/marketplace-prefill.md): `getItemMarketplacePrefill`,
 * what each marketplace's sell form will get for the item with the review's questions, and
 * `answerItemMarketplacePrefill`, the seller's tap on one of them.
 */
import type { AiClient } from '@listora/ai';
import {
  isPrefillMarketplace,
  PREFILL_MARKETPLACES,
  prefillItem,
  prefillKey,
  type PrefillMarketplace,
} from '@listora/automation';
import { accountConnections } from '@listora/connections';
import type { DbExecutor } from '@listora/db';
import type { FastifyInstance } from 'fastify';

import { contractRoute, type RouteDependencies } from '../contract/routes.ts';
import { notFound, validationFailed } from '../errors.ts';
import { findItem } from '../items/repository.ts';
import type { Tenant } from '../tenancy.ts';
import { saveAnswer } from './repository.ts';
import { loadPrefill } from './service.ts';
import { prefillView } from './views.ts';

export interface PrefillRouteDependencies extends RouteDependencies {
  ai: AiClient;
}

/** The marketplaces Listora lists on itself for the account: an API or a working session. */
export async function connectedMarketplaces(
  db: DbExecutor,
  tenant: Tenant,
): Promise<Set<PrefillMarketplace>> {
  const connections = await accountConnections(db, tenant.accountId);
  return new Set(
    PREFILL_MARKETPLACES.filter((marketplace) => {
      const connection = connections.get(marketplace);
      return (
        connection !== undefined &&
        (connection.mode === 'api' || connection.mode === 'automation') &&
        (connection.status === 'connected' || connection.status === 'degraded')
      );
    }),
  );
}

export function registerPrefillRoutes(app: FastifyInstance, deps: PrefillRouteDependencies): void {
  contractRoute(
    app,
    deps,
    'getItemMarketplacePrefill',
    async ({ tenant, db, params, query, request }) => {
      const item = await findItem(db, tenant, params.itemId);
      if (!item) throw notFound('Item');
      const connected = await connectedMarketplaces(db, tenant);
      const { prefill } = await loadPrefill(db, tenant, item, query, {
        ai: deps.ai,
        aiFor: connected,
        onAiFailure: (error) => {
          request.log.warn({ err: error, event: 'prefill_ai_failed' }, 'pre-fill AI call failed');
        },
      });
      return { status: 200, body: prefillView(prefill, connected) };
    },
  );

  contractRoute(
    app,
    deps,
    'answerItemMarketplacePrefill',
    async ({ tenant, db, params, body, request }) => {
      const item = await findItem(db, tenant, params.itemId);
      if (!item) throw notFound('Item');
      const marketplace = body.marketplace ?? null;
      if (body.field === 'kids_gender' ? marketplace !== null : marketplace === null) {
        throw validationFailed(
          [
            {
              field: 'marketplace',
              message: body.field === 'kids_gender' ? 'must be left out' : 'is required',
            },
          ],
          'Say which marketplace the answer is for.',
        );
      }
      if (marketplace !== null && !isPrefillMarketplace(marketplace)) {
        throw validationFailed(
          [{ field: 'marketplace', message: 'has no pre-fill' }],
          'Listora fills only Depop, Poshmark, and Mercari this way.',
        );
      }
      const key = prefillKey(marketplace, body.field);
      const value = body.value?.trim() ?? null;
      const connected = await connectedMarketplaces(db, tenant);
      const current = await loadPrefill(db, tenant, item, body.details, {
        ai: null,
        aiFor: connected,
      });
      if (value !== null) {
        // Taken only when the marketplace offers it: the pre-fill must then show it as the seller's.
        const answers = new Map([...current.answers, [key, value]]);
        const check = prefillItem({ item: current.details, answers, picks: current.picks });
        const fields =
          marketplace === null
            ? check.item
            : (check.marketplaces.find((entry) => entry.marketplace === marketplace)?.fields ?? []);
        const field = fields.find((entry) => entry.key === body.field);
        if (field?.source !== 'you' || field.value?.value !== value) {
          throw validationFailed(
            [{ field: 'value', message: 'is not one the marketplace offers here' }],
            'That choice isn’t offered for this item. Pick one from the list.',
          );
        }
      }
      await saveAnswer(db, tenant, { itemId: item.id, key, value, basis: current.basis });
      const { prefill } = await loadPrefill(db, tenant, item, body.details, {
        ai: deps.ai,
        aiFor: connected,
        onAiFailure: (error) => {
          request.log.warn({ err: error, event: 'prefill_ai_failed' }, 'pre-fill AI call failed');
        },
      });
      return { status: 200, body: prefillView(prefill, connected) };
    },
  );
}
