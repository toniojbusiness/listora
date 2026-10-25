/**
 * Reading capability flags (docs/features/marketplaces.md). The engine routes every operation
 * by `operationMode`, never by the marketplace name, and `checkCapabilities` keeps a set of
 * flags from promising a success it could not establish.
 */
import type { Marketplace, OperationKind } from '@listora/db';
import { assertNever } from '@listora/shared';

import {
  MARKETPLACE_NAMES,
  type DesiredListingState,
  type MarketplaceCapabilities,
  type WriteOperationKind,
} from './adapter.ts';

/** The capability flag that governs each kind of write. */
export const CAPABILITY_FOR_KIND = {
  create: 'create',
  revise: 'updateDetails',
  price: 'updatePrice',
  end: 'delist',
  relist: 'relist',
  mark_sold: 'markSold',
} as const satisfies Record<WriteOperationKind, keyof MarketplaceCapabilities>;

/**
 * How the engine runs one kind of operation. `api`: Listora sends it and a read-back decides.
 * `assisted`: the user does it in the marketplace app, and only their confirmation finishes it.
 * `unsupported`: Listora can't do it there (no mode, a bulk file it does not produce yet, or a
 * mark-sold the marketplace does itself), so the operation fails without being sent.
 */
export type OperationMode = 'api' | 'assisted' | 'unsupported';

export function operationMode(
  capabilities: MarketplaceCapabilities,
  kind: OperationKind,
): OperationMode {
  const canRead = capabilities.verifyRead === 'api';
  if (kind === 'verify') return canRead ? 'api' : 'unsupported';
  const mode = capabilities[CAPABILITY_FOR_KIND[kind]];
  switch (mode) {
    case 'api':
      // An API write that nothing can read back could never be confirmed.
      return canRead ? 'api' : 'unsupported';
    case 'assisted':
      return 'assisted';
    case 'bulk_file':
    case 'none':
    case 'not_needed':
      return 'unsupported';
    default:
      return assertNever(mode, 'capability mode');
  }
}

/**
 * The part of a desired state a read-back can show under these capabilities: everything but
 * the title on a marketplace whose listings have none (Depop), which reads never carry.
 */
export function readBackState(
  desired: DesiredListingState,
  capabilities: MarketplaceCapabilities,
): DesiredListingState {
  if (capabilities.title === 'field' || desired.title === undefined) return desired;
  const shown = { ...desired };
  delete shown.title;
  return shown;
}

/** "Listora can't <phrase> on Poshmark." */
const UNSUPPORTED_PHRASE = {
  create: 'list',
  revise: 'edit listings',
  price: 'change prices',
  end: 'delist',
  relist: 'relist',
  mark_sold: 'mark listings sold',
} as const satisfies Record<WriteOperationKind, string>;

/** The user-readable reason an `unsupported` operation fails. */
export function unsupportedMessage(kind: OperationKind, marketplace: Marketplace): string {
  const name = MARKETPLACE_NAMES[marketplace];
  return kind === 'verify'
    ? `Listora can't check ${name} listings itself.`
    : `Listora can't ${UNSUPPORTED_PHRASE[kind]} on ${name}.`;
}

/**
 * Contradictions in a set of capability flags; empty when it is coherent. The registry refuses
 * an adapter whose flags contradict each other.
 */
export function checkCapabilities(capabilities: MarketplaceCapabilities): string[] {
  const problems: string[] = [];
  if (capabilities.verifyRead !== 'api') {
    for (const flag of Object.values(CAPABILITY_FOR_KIND)) {
      if (capabilities[flag] === 'api') {
        problems.push(`${flag} is api, but verifyRead is not: no read-back could confirm it`);
      }
    }
    if (capabilities.readFreshness !== 'none') {
      problems.push('readFreshness needs verifyRead api: there are no reads to mark');
    }
  }
  for (const [name, value] of Object.entries(capabilities.limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      problems.push(`limits.${name} must be a positive integer`);
    }
  }
  return problems;
}
