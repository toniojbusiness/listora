/**
 * Money is always an integer number of minor units (cents) plus a currency.
 * Never use floating-point dollars for amounts; convert only at display edges.
 */

/** ISO 4217 code. Listora launches US-only, so USD is the only accepted currency for now. */
export type CurrencyCode = 'USD';

export interface Money {
  readonly amountCents: number;
  readonly currency: CurrencyCode;
}

/** Creates a Money value, rejecting fractional, non-finite, or unsafe cent amounts. */
export function money(amountCents: number, currency: CurrencyCode = 'USD'): Money {
  assertCents(amountCents);
  return { amountCents, currency };
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountCents + b.amountCents, a.currency);
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountCents - b.amountCents, a.currency);
}

function assertCents(amountCents: number): void {
  if (!Number.isSafeInteger(amountCents)) {
    throw new RangeError(`Money amounts must be safe integer cents, got ${String(amountCents)}`);
  }
}

function assertSameCurrency(a: Money, b: Money): void {
  // Compared as plain strings so the guard stays meaningful while USD is the only code.
  const left: string = a.currency;
  const right: string = b.currency;
  if (left !== right) {
    throw new TypeError(`Currency mismatch: ${left} vs ${right}`);
  }
}
