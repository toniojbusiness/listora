/**
 * Deleting every stored object of something that was deleted (an account, a marketplace
 * connection) and checking that none is left, for the deletion jobs (docs/features/privacy.md).
 */
import { MAX_LIST_KEYS, type ObjectStorage } from './storage.ts';

export interface ObjectsToPurge {
  /** Objects named by the deleted rows (public keys are unguessable, so only rows find them). */
  keys: readonly string[];
  /** Key prefixes that hold only the deleted thing's objects (`photos/<account>/`). */
  prefixes?: readonly string[];
}

export interface PurgeResult {
  /** Objects this call deleted or found already gone. */
  deleted: number;
  /** Keys that could not be deleted, or are still there after the delete; empty when done. */
  remaining: string[];
}

/** How many pages of one prefix a call deletes at most; the caller runs again for the rest. */
const MAX_PAGES = 20;

/**
 * Deletes the objects and everything under the prefixes, then reads each back: a key is
 * deleted only once storage no longer has it. Never throws for an object storage failure; the
 * keys it could not settle are in `remaining`, so the caller tries again later.
 */
export async function purgeObjects(
  storage: ObjectStorage,
  objects: ObjectsToPurge,
): Promise<PurgeResult> {
  const remaining: string[] = [];
  let deleted = 0;
  for (const key of new Set(objects.keys)) {
    if (await deleteChecked(storage, key)) deleted += 1;
    else remaining.push(key);
  }
  for (const prefix of objects.prefixes ?? []) {
    const result = await purgePrefix(storage, prefix);
    deleted += result.deleted;
    remaining.push(...result.remaining);
  }
  return { deleted, remaining };
}

async function purgePrefix(storage: ObjectStorage, prefix: string): Promise<PurgeResult> {
  let deleted = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let keys: string[];
    try {
      keys = await storage.list(prefix, MAX_LIST_KEYS);
    } catch {
      return { deleted, remaining: [prefix] };
    }
    if (keys.length === 0) return { deleted, remaining: [] };
    const settled = await Promise.all(keys.map((key) => deleteChecked(storage, key)));
    const stuck = keys.filter((_, index) => settled[index] !== true);
    deleted += keys.length - stuck.length;
    // Listing again would return the same keys: report them rather than loop.
    if (stuck.length > 0) return { deleted, remaining: stuck };
  }
  return { deleted, remaining: [prefix] };
}

async function deleteChecked(storage: ObjectStorage, key: string): Promise<boolean> {
  try {
    await storage.delete(key);
    return (await storage.head(key)) === undefined;
  } catch {
    return false;
  }
}
