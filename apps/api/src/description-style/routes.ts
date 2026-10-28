import {
  DEFAULT_DEPOP_DESCRIPTION_STYLE,
  loadDescriptionStyle,
  saveDescriptionStyle,
  type DescriptionStyle as StoredStyle,
} from '@listora/analysis';
import type { DescriptionStyle } from '@listora/api-contract';
import type { FastifyInstance } from 'fastify';

import { contractRoute, type RouteDependencies } from '../contract/routes.ts';
import { ApiError, validationFailed } from '../errors.ts';

/**
 * The description style Settings shows (docs/features/description-style.md):
 * `getDescriptionStyle` (the account's own Depop style, else Listora's default) and
 * `replaceDescriptionStyle`, which saves it or goes back to the default.
 */
export function registerDescriptionStyleRoutes(
  app: FastifyInstance,
  deps: RouteDependencies,
): void {
  contractRoute(app, deps, 'getDescriptionStyle', async ({ tenant, db }) => ({
    status: 200,
    body: styleView(await loadDescriptionStyle(db, tenant.accountId)),
  }));

  contractRoute(app, deps, 'replaceDescriptionStyle', async ({ tenant, db, body }) => {
    // The style is the shop's voice: only who runs the account may change it.
    if (tenant.role === 'member') {
      throw new ApiError('forbidden', "Only the account's owner can change the description style.");
    }
    let depop: string | null = null;
    if (body.depop !== undefined) {
      depop = body.depop.trim();
      if (depop === '') {
        throw validationFailed([
          { field: 'depop', message: "Enter a style, or leave it out to use Listora's default." },
        ]);
      }
      // Saving the default unchanged keeps the account on the default, so it gets its updates.
      if (depop === DEFAULT_DEPOP_DESCRIPTION_STYLE) depop = null;
    }
    const saved = await saveDescriptionStyle(db, tenant.accountId, { depop });
    return { status: 200, body: styleView(saved) };
  });
}

function styleView(style: StoredStyle): DescriptionStyle {
  return style.depop === null
    ? { depop: DEFAULT_DEPOP_DESCRIPTION_STYLE, depopIsDefault: true }
    : { depop: style.depop, depopIsDefault: false };
}
