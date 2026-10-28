/**
 * Offers in the API (docs/features/offers.md), on real Postgres: a pending offer is an
 * `answer_offer` task with its amount, what accepting gives after fees, and Open in Depop; the
 * seller's answer is queued for their iPhone only on their request, once per key, and shown as
 * done only once read back (the phone's side is in automation's phone/work.int.test.ts);
 * completing the task by hand is refused; answers for an offer that moved, a counter out of range,
 * an offer no longer waiting, or a connection Listora can't answer from are refused; and another
 * account's offers are invisible.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Tenant } from '../tenancy.ts';
import { createTestApi, type TestApi } from '../test-support.ts';

const OWNER = 'offers.owner@example.com';
const STRANGER = 'offers.stranger@example.com';

describe('offers (real Postgres)', () => {
  let api: TestApi;
  let token: string;
  let tenant: Tenant;
  let connectionId: string;
  let sequence = 0;

  beforeAll(async () => {
    api = await createTestApi('offers');
    token = await api.signIn(OWNER);
    tenant = await api.tenantOf(OWNER);
    ({ id: connectionId } = await api.db
      .insertInto('marketplace_connection')
      .values({
        account_id: tenant.accountId,
        marketplace: 'depop',
        mode: 'automation',
        status: 'connected',
        token_ciphertext: Buffer.from('sealed'),
        runs_on: 'phone',
      })
      .returning('id')
      .executeTakeFirstOrThrow());
  });

  afterAll(async () => {
    await api.close();
  });

  /** A pending Depop offer the phone read, with its open task. */
  async function pendingOffer(amountCents = 3000) {
    sequence += 1;
    const offer = await api.db
      .insertInto('marketplace_offer')
      .values({
        account_id: tenant.accountId,
        connection_id: connectionId,
        marketplace: 'depop',
        external_offer_id: `offer-${String(sequence)}`,
        listing_title: 'Wool scarf',
        amount_cents: amountCents,
        list_price_cents: 4000,
        buyer_name: 'scarffan',
        offer_url: `https://www.depop.com/sellinghub/offers/offer-${String(sequence)}/`,
        expires_at: new Date(Date.now() + 3_600_000),
      })
      .returning(['id', 'offer_url'])
      .executeTakeFirstOrThrow();
    await api.db
      .insertInto('user_task')
      .values({
        account_id: tenant.accountId,
        kind: 'answer_offer',
        offer_id: offer.id,
        deep_link: offer.offer_url,
      })
      .execute();
    return offer;
  }

  const taskOf = async (offerId: string) => {
    const list = await api.call('listTasks', { token, query: { status: ['open', 'completed'] } });
    return list.body.data.find((task) => task.offer?.id === offerId);
  };
  const answer = (
    offerId: string,
    body: Record<string, unknown>,
    options: { idempotencyKey?: string; token?: string } = {},
  ) =>
    api.call('answerOffer', {
      token: options.token ?? token,
      params: { offerId },
      body,
      ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    });
  const usd = (amountCents: number) => ({ amountCents, currency: 'USD' });

  it('shows a pending offer as a task with its amount, net after fees, answers, and Open in Depop', async () => {
    const offer = await pendingOffer();
    const task = await taskOf(offer.id);
    expect(task).toMatchObject({
      kind: 'answer_offer',
      status: 'open',
      marketplace: 'depop',
      title: '$30.00 offer on Depop',
      deepLink: offer.offer_url,
      offer: {
        id: offer.id,
        status: 'pending',
        amount: usd(3000),
        listPrice: usd(4000),
        buyerName: 'scarffan',
        listingTitle: 'Wool scarf',
        url: offer.offer_url,
        actions: ['accept', 'decline', 'counter'],
        counterRange: { above: usd(3000), below: usd(4000) },
      },
    });
    const accept = task?.offer?.accept;
    expect(accept?.price).toEqual(usd(3000));
    expect((accept?.net.amountCents ?? 0) + (accept?.fees.amountCents ?? 0)).toBe(3000);
    expect(accept?.fees.amountCents).toBeGreaterThan(0);
    // Done only when the marketplace shows the answer, never on the seller's word.
    const completed = await api.call('completeTask', {
      token,
      params: { taskId: task?.id ?? '' },
      body: {},
    });
    expect(completed.status).toBe(409);
  });

  it('queues the seller’s answer for their iPhone once per key, and refuses a second while it runs', async () => {
    const offer = await pendingOffer();
    const key = crypto.randomUUID();
    const first = await answer(
      offer.id,
      { action: 'accept', offerAmount: usd(3000) },
      {
        idempotencyKey: key,
      },
    );
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({
      action: 'accept',
      status: 'queued',
      statusText: 'Accepting on your iPhone...',
      offerAmount: usd(3000),
    });
    const again = await answer(
      offer.id,
      { action: 'accept', offerAmount: usd(3000) },
      {
        idempotencyKey: key,
      },
    );
    expect(again.body).toEqual(first.body);
    const work = await api.db
      .selectFrom('phone_work')
      .select(['purpose', 'offer_response_id'])
      .where('account_id', '=', tenant.accountId)
      .where('purpose', '=', 'offer_response')
      .execute();
    expect(work).toEqual([{ purpose: 'offer_response', offer_response_id: first.body.id }]);
    const another = await answer(offer.id, { action: 'decline', offerAmount: usd(3000) });
    expect(another.status).toBe(409);
    expect(another.error.code).toBe('invalid_state_transition');
    // While it runs, the offer offers no answers, and says what is under way.
    const shown = await api.call('getOffer', { token, params: { offerId: offer.id } });
    expect(shown.body).toMatchObject({ actions: [], response: { status: 'queued' } });
  });

  it('shows an answer done only once read back, and its task closes', async () => {
    const offer = await pendingOffer();
    const sent = await answer(offer.id, {
      action: 'counter',
      offerAmount: usd(3000),
      counter: usd(3500),
    });
    expect(sent.body.statusText).toBe('Countering at $35 on your iPhone...');
    await api.db
      .updateTable('offer_response')
      .set({
        status: 'succeeded',
        success_evidence: 'read_back',
        sent: true,
        finished_at: sql<Date>`now()`,
      })
      .where('id', '=', sent.body.id)
      .execute();
    await api.db
      .updateTable('marketplace_offer')
      .set({ status: 'countered', amount_cents: 3500, closed_at: sql<Date>`now()` })
      .where('id', '=', offer.id)
      .execute();
    await api.db
      .updateTable('user_task')
      .set({ status: 'done', completed_at: sql<Date>`now()` })
      .where('offer_id', '=', offer.id)
      .execute();
    const task = await taskOf(offer.id);
    expect(task).toMatchObject({
      status: 'completed',
      offer: {
        status: 'countered',
        actions: [],
        response: { status: 'succeeded', statusText: 'Countered at $35 (confirmed by Depop)' },
      },
    });
  });

  it('refuses an answer for an offer that moved, a counter out of range, or an offer no longer waiting', async () => {
    const offer = await pendingOffer();
    const moved = await answer(offer.id, { action: 'accept', offerAmount: usd(2900) });
    expect(moved.status).toBe(422);
    const low = await answer(offer.id, {
      action: 'counter',
      offerAmount: usd(3000),
      counter: usd(3000),
    });
    expect(low.status).toBe(422);
    const high = await answer(offer.id, {
      action: 'counter',
      offerAmount: usd(3000),
      counter: usd(4000),
    });
    expect(high.status).toBe(422);
    const stray = await answer(offer.id, {
      action: 'accept',
      offerAmount: usd(3000),
      counter: usd(3500),
    });
    expect(stray.status).toBe(422);
    await api.db
      .updateTable('marketplace_offer')
      .set({ status: 'closed', closed_at: sql<Date>`now()` })
      .where('id', '=', offer.id)
      .execute();
    const closed = await answer(offer.id, { action: 'accept', offerAmount: usd(3000) });
    expect(closed.status).toBe(409);
    const responses = await api.db
      .selectFrom('offer_response')
      .select('id')
      .where('offer_id', '=', offer.id)
      .execute();
    expect(responses).toEqual([]);
  });

  it("quotes a counteroffer's net after fees, and hides another account's offers", async () => {
    const offer = await pendingOffer();
    const quote = await api.call('getOfferQuote', {
      token,
      params: { offerId: offer.id },
      query: { priceCents: 3500 },
    });
    expect(quote.body.price).toEqual(usd(3500));
    expect(quote.body.net.amountCents + quote.body.fees.amountCents).toBe(3500);
    const stranger = await api.signIn(STRANGER);
    expect(
      (await api.call('getOffer', { token: stranger, params: { offerId: offer.id } })).status,
    ).toBe(404);
    const refused = await answer(
      offer.id,
      { action: 'accept', offerAmount: usd(3000) },
      { token: stranger },
    );
    expect(refused.status).toBe(404);
  });

  it('asks the phone to read the offers, at most every 10 minutes, and says when they were read', async () => {
    const before = await api.call('listOfferChecks', { token });
    expect(before.body.data).toEqual([{ marketplace: 'depop', status: 'ok' }]);
    const asked = await api.call('requestOfferChecks', { token });
    expect(asked.body.data).toEqual([{ marketplace: 'depop', status: 'waiting' }]);
    await api.db
      .deleteFrom('phone_work')
      .where('account_id', '=', tenant.accountId)
      .where('purpose', '=', 'offer_check')
      .execute();
    // Asked again within 10 minutes: no new read.
    const again = await api.call('requestOfferChecks', { token });
    expect(again.body.data).toEqual([{ marketplace: 'depop', status: 'ok' }]);
  });

  it('offers no answers on a read-only account, and refuses one, while a writable one takes it', async () => {
    const offer = await pendingOffer();
    const setReadOnly = (on: boolean) =>
      api.db
        .updateTable('marketplace_connection')
        .set({ read_only: on })
        .where('id', '=', connectionId)
        .execute();
    await setReadOnly(true);
    const shown = await api.call('getOffer', { token, params: { offerId: offer.id } });
    expect(shown.body.actions).toEqual([]);
    expect(shown.body.acceptNote).toContain('read only');
    const refused = await answer(offer.id, { action: 'accept', offerAmount: usd(3000) });
    expect(refused.status).toBe(409);
    expect(refused.error.code).toBe('marketplace_action_unavailable');
    await setReadOnly(false);
    const taken = await answer(offer.id, { action: 'accept', offerAmount: usd(3000) });
    expect(taken.status).toBe(202);
  });
});
