import type { FieldError, Profile, ProfileReplace } from '@listora/api-contract';
import { inTransaction } from '@listora/db';
import type { FastifyInstance } from 'fastify';

import { contractRoute, type RouteDependencies } from '../contract/routes.ts';
import { ApiError, validationFailed } from '../errors.ts';
import { loadProfile, saveProfile, type ProfileRow } from './repository.ts';

/**
 * The profile Settings shows (docs/features/profile.md): `getProfile` (the sign-in email, the
 * person's name, the account's business name) and `replaceProfile`, which saves both names.
 */
export function registerProfileRoutes(app: FastifyInstance, deps: RouteDependencies): void {
  contractRoute(app, deps, 'getProfile', async ({ tenant, db }) => ({
    status: 200,
    body: profileView(await loadProfile(db, tenant)),
  }));

  contractRoute(app, deps, 'replaceProfile', async ({ tenant, db, body }) => {
    const names = trimmedNames(body);
    const current = await loadProfile(db, tenant);
    // The business name is the account's: only who runs the account may change it.
    if (names.businessName !== current.businessName && tenant.role === 'member') {
      throw new ApiError('forbidden', "Only the account's owner can change the business name.");
    }
    const saved = await inTransaction(db, async (trx) => {
      await saveProfile(trx, tenant, names);
      return loadProfile(trx, tenant);
    });
    return { status: 200, body: profileView(saved) };
  });
}

/** Both names trimmed; absent stays null, and one that is blank once trimmed is a field error. */
function trimmedNames(body: ProfileReplace): {
  displayName: string | null;
  businessName: string | null;
} {
  const errors: FieldError[] = [];
  const trim = (field: keyof ProfileReplace, label: string): string | null => {
    const value = body[field];
    if (value === undefined) return null;
    const trimmed = value.trim();
    if (trimmed === '') errors.push({ field, message: `Enter a ${label}, or leave it out.` });
    return trimmed;
  };
  const displayName = trim('displayName', 'name');
  const businessName = trim('businessName', 'business name');
  if (errors.length > 0) throw validationFailed(errors);
  return { displayName, businessName };
}

function profileView(row: ProfileRow): Profile {
  return {
    ...(row.email === null ? {} : { email: row.email }),
    ...(row.displayName === null ? {} : { displayName: row.displayName }),
    ...(row.businessName === null ? {} : { businessName: row.businessName }),
  };
}
