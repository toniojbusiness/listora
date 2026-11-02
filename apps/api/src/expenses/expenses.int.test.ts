/**
 * Expenses against a real Postgres (docs/features/expenses.md): miles and money spent, the
 * year's mileage rate (the IRS rate until the seller sets one), and their totals in Reports and
 * the expenses CSV; only the account's own rows.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApi, type TestApi } from '../test-support.ts';

const OWNER = 'expenses.owner@example.com';
const OTHER = 'expenses.other@example.com';

const usd = (amountCents: number) => ({ amountCents, currency: 'USD' as const });

describe('expenses (real Postgres)', () => {
  let api: TestApi;
  let token: string;
  let otherToken: string;

  beforeAll(async () => {
    api = await createTestApi('expenses');
    token = await api.signIn(OWNER);
    otherToken = await api.signIn(OTHER);
  });

  afterAll(async () => {
    await api.close();
  });

  async function create(body: Record<string, unknown>, as = token) {
    return api.call('createExpense', {
      token: as,
      body: { incurredOn: '2026-03-14', category: 'Mileage', ...body },
    });
  }

  it('records miles and money spent, changes and deletes them, and lists the year', async () => {
    const miles = await create({ miles: 31, description: 'Invented flea market' });
    expect(miles.status).toBe(201);
    expect(miles.body).toMatchObject({ incurredOn: '2026-03-14', category: 'Mileage', miles: 31 });
    expect(miles.body.amount).toBeUndefined();
    const parking = await create({ category: '  Parking ', amount: usd(350) });
    expect(parking.body).toMatchObject({ category: 'Parking', amount: usd(350) });
    expect(parking.body.miles).toBeUndefined();
    await create({ incurredOn: '2025-12-31', miles: 9 });

    const changed = await api.call('replaceExpense', {
      token,
      params: { expenseId: parking.body.id },
      body: { incurredOn: '2026-04-01', category: 'Parking', amount: usd(500) },
    });
    expect(changed.status).toBe(200);
    expect(changed.body.amount).toEqual(usd(500));

    const listed = await api.call('listExpenses', { token, query: { year: 2026 } });
    expect(listed.body.expenses.map((expense) => expense.id)).toEqual([
      miles.body.id,
      parking.body.id,
    ]);

    expect(
      (await api.call('deleteExpense', { token, params: { expenseId: parking.body.id } })).status,
    ).toBe(204);
    expect(
      (await api.call('deleteExpense', { token, params: { expenseId: parking.body.id } })).status,
    ).toBe(404);
  });

  it('refuses both or neither of amount and miles, nothing spent, another currency, and a far day', async () => {
    const both = await create({ miles: 3, amount: usd(100) });
    expect(both.status).toBe(422);
    expect(both.error.fieldErrors).toEqual([
      { field: 'amount', message: 'give either an amount or miles, not both' },
    ]);
    expect((await create({})).status).toBe(422);
    const nothing = await create({ category: 'Parking', amount: usd(0) });
    expect(nothing.error.fieldErrors).toEqual([
      { field: 'amount.amountCents', message: 'must be at least 1 cent' },
    ]);
    const euros = await create({
      category: 'Parking',
      amount: { amountCents: 100, currency: 'EUR' },
    });
    expect(euros.status).toBe(422);
    const blank = await create({ category: '   ', miles: 2 });
    expect(blank.error.fieldErrors).toEqual([{ field: 'category', message: 'must not be empty' }]);
    expect((await create({ incurredOn: '1999-12-31', miles: 2 })).status).toBe(422);
  });

  it("uses the IRS rate until the seller sets the year's own, and none for a year it knows none for", async () => {
    const irs = await api.call('getMileageRate', { token, query: { year: 2026 } });
    expect(irs.body).toEqual({
      year: 2026,
      tenthCentsPerMile: 725,
      setBySeller: false,
      irsTenthCentsPerMile: 725,
    });
    const set = await api.call('setMileageRate', {
      token,
      query: { year: 2026 },
      body: { tenthCentsPerMile: 700 },
    });
    expect(set.body).toEqual({
      year: 2026,
      tenthCentsPerMile: 700,
      setBySeller: true,
      irsTenthCentsPerMile: 725,
    });
    const unknown = await api.call('getMileageRate', { token, query: { year: 2040 } });
    expect(unknown.body).toEqual({ year: 2040, setBySeller: false });
    // Another account keeps the IRS rate.
    const other = await api.call('getMileageRate', { token: otherToken, query: { year: 2026 } });
    expect(other.body.tenthCentsPerMile).toBe(725);
  });

  it('totals the year in Reports at its rate, and exports it', async () => {
    const seller = await api.signIn('expenses.report@example.com');
    await create({ incurredOn: '2027-01-05', miles: 10 }, seller);
    await create({ incurredOn: '2027-02-05', miles: 5 }, seller);
    await create({ incurredOn: '2027-02-06', category: 'Parking', amount: usd(300) }, seller);
    await create({ incurredOn: '2027-03-01', category: 'Supplies', amount: usd(1250) }, seller);
    await create({ incurredOn: '2027-03-01', category: 'parking', amount: usd(200) }, seller);

    // 2027 has no IRS rate Listora knows: the miles are counted, not priced.
    const unpriced = await api.call('getYearReport', {
      token: seller,
      query: { year: 2027, timeZone: 'America/New_York' },
    });
    expect(unpriced.body.expenses).toEqual({
      mileage: { miles: 15, trips: 2, rate: { year: 2027, setBySeller: false } },
      spent: usd(1750),
      categories: [
        { category: 'Supplies', spent: usd(1250), count: 1 },
        { category: 'Parking', spent: usd(500), count: 2 },
      ],
    });
    expect(unpriced.body.netAfterExpenses).toBeUndefined();

    await api.call('setMileageRate', {
      token: seller,
      query: { year: 2027 },
      body: { tenthCentsPerMile: 735 },
    });
    const priced = await api.call('getYearReport', {
      token: seller,
      query: { year: 2027, timeZone: 'America/New_York' },
    });
    // 15 miles at 73.5 cents is $11.025, so $11.03.
    expect(priced.body.expenses.mileage.deduction).toEqual(usd(1103));
    expect(priced.body.expenses.total).toEqual(usd(2853));
    // No sales: a net profit of $0 less the expenses.
    expect(priced.body.netAfterExpenses).toEqual(usd(-2853));

    const exported = await api.call('exportExpenses', { token: seller, query: { year: 2027 } });
    expect(exported.body.fileName).toBe('listora-expenses-2027.csv');
    expect(exported.body.rowCount).toBe(5);
    const lines = exported.body.content.slice(1).split('\r\n');
    expect(lines[0]).toBe('Date,Category,Description,Miles,Mileage deduction,Amount,Sourcing trip');
    expect(lines[1]).toBe('2027-01-05,Mileage,,10,7.35,,');
    expect(lines[3]).toBe('2027-02-06,Parking,,,,3.00,');

    // Another account sees none of it.
    const other = await api.call('listExpenses', { token: otherToken, query: { year: 2027 } });
    expect(other.body.expenses).toEqual([]);
  });

  it("does not let another account change or delete the seller's expense", async () => {
    const mine = await create({ miles: 4 });
    const body = { incurredOn: '2026-03-14', category: 'Mileage', miles: 400 };
    expect(
      (
        await api.call('replaceExpense', {
          token: otherToken,
          params: { expenseId: mine.body.id },
          body,
        })
      ).status,
    ).toBe(404);
    expect(
      (await api.call('deleteExpense', { token: otherToken, params: { expenseId: mine.body.id } }))
        .status,
    ).toBe(404);
  });
});
