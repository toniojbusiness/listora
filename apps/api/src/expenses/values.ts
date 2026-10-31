import type { ExpenseWrite, FieldError, SourcingSpend } from '@listora/api-contract';

import { validationFailed } from '../errors.ts';
import type { ExpenseValues } from './repository.ts';

/** Text as the seller typed it, spaces tidied; null for nothing. */
export function cleanText(text: string | undefined): string | null {
  const cleaned = text?.trim().replace(/\s+/g, ' ');
  return cleaned === undefined || cleaned === '' ? null : cleaned;
}

/**
 * The expense as written, or `422`: exactly one of `amount` and `miles`, an amount of at least a
 * cent in dollars, a day from 2000 to 2100, and a category that is more than spaces.
 */
export function expenseValues(body: ExpenseWrite): ExpenseValues {
  const errors: FieldError[] = [];
  const year = Number(body.incurredOn.slice(0, 4));
  if (!(year >= 2000 && year <= 2100)) {
    errors.push({ field: 'incurredOn', message: 'must be a day from 2000 to 2100' });
  }
  const category = cleanText(body.category);
  if (category === null) errors.push({ field: 'category', message: 'must not be empty' });
  if ((body.amount === undefined) === (body.miles === undefined)) {
    errors.push({ field: 'amount', message: 'give either an amount or miles, not both' });
  }
  if (body.amount !== undefined) errors.push(...amountErrors(body.amount, 'amount'));
  if (errors.length > 0) throw validationFailed(errors);
  return {
    incurredOn: body.incurredOn,
    category: category ?? '',
    description: cleanText(body.description),
    amountCents: body.amount?.amountCents ?? null,
    miles: body.miles ?? null,
  };
}

/** A trip's other spend at checkout, as expenses of the trip's day, or `422`. */
export function sourcingSpendValues(
  spend: readonly SourcingSpend[],
  incurredOn: string,
  sourcingRunId: string,
): ExpenseValues[] {
  const errors: FieldError[] = [];
  const values = spend.map((entry, index): ExpenseValues => {
    const field = `otherSpend[${String(index)}]`;
    const category = cleanText(entry.category);
    if (category === null)
      errors.push({ field: `${field}.category`, message: 'must not be empty' });
    errors.push(...amountErrors(entry.amount, `${field}.amount`));
    return {
      incurredOn,
      category: category ?? '',
      description: cleanText(entry.description),
      amountCents: entry.amount.amountCents,
      miles: null,
      sourcingRunId,
    };
  });
  if (errors.length > 0) throw validationFailed(errors);
  return values;
}

function amountErrors(
  amount: { amountCents: number; currency: string },
  field: string,
): FieldError[] {
  const errors: FieldError[] = [];
  if (amount.amountCents < 1)
    errors.push({ field: `${field}.amountCents`, message: 'must be at least 1 cent' });
  if (amount.currency !== 'USD')
    errors.push({ field: `${field}.currency`, message: 'must be USD' });
  return errors;
}
