/**
 * The marketplace pre-fill for one item (docs/features/marketplace-prefill.md): the pure
 * `prefillItem` of @listora/automation, with the seller's stored answers, the AI's stored picks,
 * and, for the questions the AI has not been asked yet, one cheap AI call whose picks are stored
 * so each question is paid for once.
 */
import { AiCallError, AiGuardError, type AiClient } from '@listora/ai';
import { pickPrefillOptions, type PrefillItemFacts } from '@listora/analysis';
import type { PrefillDetails } from '@listora/api-contract';
import {
  prefillItem,
  type ItemPrefill,
  type PrefillDecision,
  type PrefillItem,
  type PrefillMarketplace,
  type PrefillPick,
} from '@listora/automation';
import type { DbExecutor, InventoryItem } from '@listora/db';
import { ITEM_CONDITIONS, type ItemCondition } from '@listora/marketplaces';
import { photoSetHash, sha256Hex } from '@listora/shared';

import { listPhotoRows } from '../photos/repository.ts';
import type { Tenant } from '../tenancy.ts';
import { loadAnswers, loadPicks, savePicks, type StoredPick } from './repository.ts';

/** How long a review waits for the AI's picks before it asks the seller instead. */
const AI_TIMEOUT_MS = 10_000;

export interface PrefillOptions {
  /** The AI client; `null` reads only the picks already stored (a listing being created). */
  ai: AiClient | null;
  /** The marketplaces whose open questions may go to the AI (the ones being listed on). */
  aiFor: ReadonlySet<PrefillMarketplace>;
  /** Told about an AI call that failed; the questions are then asked. */
  onAiFailure?: (error: unknown) => void;
}

export interface LoadedPrefill {
  prefill: ItemPrefill;
  /** The hash of the details the answers hold for. */
  basis: string;
  details: PrefillItem;
  /** The seller's answers and the AI's picks the pre-fill was worked out with. */
  answers: ReadonlyMap<string, string>;
  picks: ReadonlyMap<string, PrefillPick>;
}

/** The item's details as the pre-fill reads them: the saved ones, with the review's edits. */
export function prefillDetails(item: InventoryItem, edits: PrefillDetails = {}): PrefillItem {
  const text = (edit: string | undefined, saved: string | null): string | null => {
    if (edit === undefined) return saved;
    const trimmed = edit.trim();
    return trimmed === '' ? null : trimmed;
  };
  const list = (edit: string | undefined, saved: readonly string[]): string[] =>
    edit === undefined
      ? [...saved]
      : edit
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry !== '');
  return {
    title: item.title,
    productName: item.product_name,
    keywords: [...item.keywords],
    description: item.description,
    category: text(edits.category, item.category),
    department: text(edits.department, item.department),
    sizeLabel: text(edits.sizeLabel, item.size_label),
    sizeSystem: text(edits.sizeSystem, item.size_system),
    brand: text(edits.brand, item.brand),
    condition: condition(text(edits.condition, item.condition)),
    colors: list(edits.colors, item.colors),
    materials: list(edits.materials, item.materials),
  };
}

/** A condition Listora knows, or none (the forms' condition maps know only those). */
function condition(value: string | null): ItemCondition | null {
  return ITEM_CONDITIONS.find((known) => known === value) ?? null;
}

/** What an answer holds for: the details that decide the marketplace's category and size. */
export function prefillBasis(details: PrefillItem): string {
  return sha256Hex(
    JSON.stringify([details.category, details.department, details.sizeLabel, details.sizeSystem]),
  );
}

/** The details the AI reads (text only). */
function facts(details: PrefillItem): PrefillItemFacts {
  return {
    title: details.title,
    productName: details.productName,
    brand: details.brand,
    category: details.category,
    department: details.department,
    sizeLabel: details.sizeLabel,
    sizeSystem: details.sizeSystem,
    colors: details.colors,
    keywords: details.keywords,
    description: details.description,
  };
}

/** A question is the item's details and the list it chooses from; a new list is a new one. */
function decisionHash(details: PrefillItemFacts, decision: PrefillDecision): string {
  return sha256Hex(
    JSON.stringify({
      key: decision.key,
      options: decision.options.map((option) => option.value),
      item: details,
    }),
  );
}

function decisionMarketplace(key: string): PrefillMarketplace | 'item' {
  const [marketplace, field] = key.split('.');
  return field === undefined ? 'item' : (marketplace as PrefillMarketplace);
}

/**
 * The item's pre-fill with its stored answers and picks. Questions without a stored pick, for
 * the marketplaces in `aiFor`, are asked in one AI call, whose picks are stored. Girls or boys
 * goes to the AI when any of them is a marketplace that files kids' items by it.
 */
export async function loadPrefill(
  db: DbExecutor,
  tenant: Tenant,
  item: InventoryItem,
  edits: PrefillDetails,
  options: PrefillOptions,
): Promise<LoadedPrefill> {
  const details = prefillDetails(item, edits);
  const basis = prefillBasis(details);
  const answers = await loadAnswers(db, tenant, item.id, basis);
  const itemFacts = facts(details);
  const picks = new Map<string, PrefillPick>();
  let asked = false;
  let prefill = prefillItem({ item: details, answers, picks });
  // A pick can open a question that depends on it (the size of the category the AI picked), so
  // the stored picks are read again for the new questions; the AI is asked once at most.
  for (let round = 0; round < 3 && prefill.decisions.length > 0; round += 1) {
    const open = prefill.decisions.map((decision) => ({
      decision,
      hash: decisionHash(itemFacts, decision),
    }));
    const stored = await loadPicks(
      db,
      tenant,
      item.id,
      open.map((entry) => entry.hash),
    );
    let added = false;
    for (const { decision, hash } of open) {
      const pick = stored.find((entry) => entry.decisionHash === hash);
      if (pick !== undefined && !picks.has(decision.key)) {
        picks.set(decision.key, { value: pick.value, confidence: pick.confidence });
        added = true;
      }
    }
    if (!added) {
      const ask = open.filter(({ decision }) => {
        if (picks.has(decision.key)) return false;
        const marketplace = decisionMarketplace(decision.key);
        return marketplace === 'item'
          ? options.aiFor.has('mercari') || options.aiFor.has('poshmark')
          : options.aiFor.has(marketplace);
      });
      if (asked || options.ai === null || ask.length === 0) break;
      asked = true;
      const answered = await askAi(db, tenant, item, itemFacts, ask, options);
      if (answered.length === 0) break;
      for (const pick of answered) {
        picks.set(pick.key, { value: pick.value, confidence: pick.confidence });
      }
    }
    prefill = prefillItem({ item: details, answers, picks });
  }
  return { prefill, basis, details, answers, picks };
}

async function askAi(
  db: DbExecutor,
  tenant: Tenant,
  item: InventoryItem,
  itemFacts: PrefillItemFacts,
  ask: readonly { decision: PrefillDecision; hash: string }[],
  options: PrefillOptions & { ai: AiClient | null },
): Promise<StoredPick[]> {
  if (options.ai === null) return [];
  const photos = await listPhotoRows(db, tenant, item.id);
  const hash = photoSetHash(
    photos.flatMap((photo) => (photo.sha256 === null ? [] : [photo.sha256])),
  );
  try {
    const { picks } = await pickPrefillOptions(options.ai, {
      accountId: tenant.accountId,
      userId: tenant.userId,
      itemId: item.id,
      photoSetHash: hash,
      item: itemFacts,
      questions: ask.map(({ decision }) => decision),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });
    const stored = ask.map(({ decision, hash: decisionHash }) => {
      const pick = picks.get(decision.key);
      return {
        decisionHash,
        key: decision.key,
        value: pick?.value ?? null,
        confidence: pick?.confidence ?? 0,
      };
    });
    await savePicks(db, tenant, item.id, stored);
    return stored;
  } catch (error) {
    options.onAiFailure?.(error);
    // A billed call that failed is not paid for again: its questions go to the seller. A
    // refused one (AI off, over budget) or one never billed is tried again on the next read.
    if (error instanceof AiCallError && error.costMicros > 0) {
      const failed = ask.map(({ decision, hash: decisionHash }) => ({
        decisionHash,
        key: decision.key,
        value: null,
        confidence: 0,
      }));
      await savePicks(db, tenant, item.id, failed);
      return failed;
    }
    if (error instanceof AiGuardError || error instanceof AiCallError) return [];
    throw error;
  }
}
