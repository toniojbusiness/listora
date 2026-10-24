import type { DbTransaction } from './database.ts';

/** Last number a 6-digit SKU counter can allocate (decision D12). */
export const MAX_SKU_NUMBER = 999_999;

export class SkuAllocationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SkuAllocationError';
  }
}

/** `AJ` and 184 → `AJ-000184`. */
export function formatSku(prefix: string, number: number): string {
  if (!/^[A-Z]{2,4}$/.test(prefix)) {
    throw new RangeError(`SKU prefix must be 2-4 capital letters, got ${prefix}`);
  }
  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_SKU_NUMBER) {
    throw new RangeError(
      `SKU number must be from 1 to ${String(MAX_SKU_NUMBER)}, got ${String(number)}`,
    );
  }
  return `${prefix}-${String(number).padStart(6, '0')}`;
}

/**
 * Allocates the account's next SKU. It must run inside the transaction that creates the item
 * (the type requires a transaction): the counter row stays locked until that transaction ends,
 * which serializes concurrent creates in one account, and a rollback returns the number, so
 * SKUs are unique and gapless per account.
 */
export async function allocateSku(trx: DbTransaction, accountId: string): Promise<string> {
  let allocated: { next_number: number; sku_prefix: string } | undefined;
  try {
    allocated = await trx
      .updateTable('sku_sequence')
      .from('account')
      .set((eb) => ({ next_number: eb('sku_sequence.next_number', '+', 1) }))
      .whereRef('account.id', '=', 'sku_sequence.account_id')
      .where('sku_sequence.account_id', '=', accountId)
      .returning(['sku_sequence.next_number', 'account.sku_prefix'])
      .executeTakeFirst();
  } catch (error) {
    if (isCheckViolation(error, 'sku_sequence_next_number_check')) {
      throw new SkuAllocationError(
        `Account ${accountId} has used all ${String(MAX_SKU_NUMBER)} SKU numbers`,
        { cause: error },
      );
    }
    throw error;
  }
  if (allocated === undefined) {
    throw new SkuAllocationError(`Account ${accountId} does not exist`);
  }
  // The update returns the incremented counter; the number just allocated is one less.
  return formatSku(allocated.sku_prefix, allocated.next_number - 1);
}

function isCheckViolation(error: unknown, constraint: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23514' &&
    'constraint' in error &&
    error.constraint === constraint
  );
}
