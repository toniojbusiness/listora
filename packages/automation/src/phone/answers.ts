/**
 * What the phone answers for a call, checked before the server uses it
 * (docs/features/phone-execution.md). The app is the seller's own, but its answer crosses the
 * network, so it is held to the shape a runner's answer has: a script result whose value is what
 * that script returns, bounded strings, and no screenshot (only the runner keeps those, in its
 * own storage). An answer that is not what the call returns counts as a script failure of the
 * phone, and a write's as one that may have changed the listing, so a read-back decides.
 */
import { z } from 'zod';

import { CHALLENGE_KINDS, FEE_KINDS } from '@listora/db';
import { ITEM_CONDITIONS, REMOTE_LISTING_STATUSES } from '@listora/marketplaces';

import type { ScriptCall } from '../adapter/script-call.ts';
import { isWriteCall, sellerIdentity } from '../adapter/script-call.ts';
import type { SessionRun } from '../adapter/sessions.ts';
import type { ScriptErrorCode, ScriptResult } from '../runner/types.ts';
import { pageEvidenceSchema, type PageEvidence } from '../safety/evidence.ts';

const SCRIPT_ERROR_CODES = [
  'rate_limited',
  'server_error',
  'unreachable',
  'element_missing',
  'aborted',
  'browser_unavailable',
  'script_error',
  'stopped_for_check',
  'read_only',
] as const satisfies readonly ScriptErrorCode[];

const short = z.string().min(1).max(100);
const message = z
  .string()
  .max(2_000)
  .transform((text) => text.slice(0, 200));

const failure = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('challenge'), challenge: z.enum(CHALLENGE_KINDS), step: short }),
  z.object({ kind: z.literal('timeout'), step: short }),
  z.object({
    kind: z.literal('error'),
    step: short,
    code: z.enum(SCRIPT_ERROR_CODES),
    message,
    retryAfterMs: z.number().int().min(0).max(86_400_000).nullable(),
  }),
]);

const foundListing = z.object({
  found: z.literal(true),
  externalListingId: z.string().min(1).max(200),
  externalUrl: z.string().max(2_000).nullable(),
  status: z.enum(REMOTE_LISTING_STATUSES),
  title: z.string().max(5_000).nullable(),
  description: z.string().max(50_000).nullable(),
  priceCents: z.number().int().min(0).nullable(),
  currency: z.literal('USD').nullable(),
  revision: z.number().int().min(0).nullable(),
  // An app whose scripts predate refreshes sends none.
  refreshedAt: z.iso.datetime({ offset: true }).nullable().default(null),
});

const listingState = z.discriminatedUnion('found', [
  z.object({ found: z.literal(false), authoritative: z.boolean() }),
  foundListing,
]);

/** A listing as an import reads it: its state and what the item takes from it. */
const listedListing = foundListing.extend({
  details: z.object({
    photoUrls: z.array(z.url({ protocol: /^https?$/ }).max(2_000)).max(30),
    brand: z.string().max(200).nullable(),
    size: z.string().max(100).nullable(),
    condition: z.enum(ITEM_CONDITIONS).nullable(),
    categoryRef: z.string().max(500).nullable(),
    categoryPath: z.array(z.string().min(1).max(200)).max(8),
    // A phone on an older app answers without them.
    colors: z.array(z.string().min(1).max(50)).max(8).default([]),
    originalPriceCents: z.number().int().min(0).nullable().default(null),
    sku: z.string().min(1).max(64).nullable(),
  }),
  // One Listora already held, read from the list alone (`ListedListing`).
  fromList: z.literal(true).optional(),
});

const writeResult = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('applied'),
    externalListingId: z.string().min(1).max(200).optional(),
    revision: z.number().int().min(0).optional(),
  }),
  z.object({
    type: z.literal('rejected'),
    code: short,
    message: z.string().min(1).max(1_000),
    fixHint: z.string().min(1).max(1_000).optional(),
  }),
]);

const orders = z
  .array(
    z.object({
      externalOrderId: z.string().min(1).max(200),
      soldAt: z.iso.datetime({ offset: true }).transform((time) => new Date(time)),
      shipped: z.boolean().optional(),
      fees: z
        .array(
          z.object({
            kind: z.enum(FEE_KINDS),
            description: z.string().min(1).max(200),
            amountCents: z.number().int(),
            currency: z.literal('USD'),
          }),
        )
        .max(20)
        .optional(),
      items: z
        .array(
          z.object({
            externalListingId: z.string().min(1).max(200).nullable(),
            title: z.string().max(5_000).nullable(),
            priceCents: z.number().int().min(0),
            currency: z.literal('USD'),
            listing: listedListing.optional(),
          }),
        )
        .max(100),
    }),
  )
  .max(1_000);

const labelTime = z.iso
  .datetime({ offset: true })
  .transform((time) => new Date(time))
  .nullable()
  .optional();

/**
 * An order's label as the phone read it: its tracking number, carrier, and expiry, the buyer's
 * first name only, and how the order stands and must ship by.
 */
const labels = z
  .array(
    z.discriminatedUnion('found', [
      z.object({
        externalOrderId: z.string().min(1).max(200),
        found: z.literal(true),
        trackingNumber: z.string().min(1).max(100).nullable(),
        buyerFirstName: z.string().min(1).max(100).nullable(),
        orderState: z.enum(['to_ship', 'shipped', 'canceled']).optional(),
        carrierName: z.string().min(1).max(100).nullable().optional(),
        shipBy: labelTime,
        labelExpiresAt: labelTime,
      }),
      z.object({ externalOrderId: z.string().min(1).max(200), found: z.literal(false) }),
    ]),
  )
  .max(100);

const isoTime = z.iso.datetime({ offset: true }).nullable();

/** An offer as the phone read it (docs/features/offers.md): only what Tasks shows of it. */
const offer = z.object({
  externalOfferId: z.string().min(1).max(255),
  externalListingId: z.string().min(1).max(255).nullable(),
  listingTitle: z.string().max(5_000).nullable(),
  amountCents: z.number().int().min(1),
  listPriceCents: z.number().int().min(1).nullable(),
  buyerName: z.string().min(1).max(100).nullable(),
  turn: z.enum(['seller', 'buyer']),
  madeAt: isoTime,
  expiresAt: isoTime,
  url: z
    .url({ protocol: /^https?$/ })
    .max(2_000)
    .nullable(),
  listingCount: z.number().int().min(1).max(500).nullable(),
  shippingCents: z.number().int().min(0).nullable(),
});

const offerState = z.discriminatedUnion('found', [
  z.object({ found: z.literal(false) }),
  z.object({
    found: z.literal(true),
    offer,
    status: z.enum(['pending', 'accepted', 'declined', 'countered']),
  }),
]);

const offerAnswer = z.discriminatedUnion('type', [
  z.object({ type: z.literal('applied') }),
  z.object({ type: z.literal('refused'), code: short, message: z.string().min(1).max(1_000) }),
]);

/** What each script's value is. */
function valueSchema(call: ScriptCall): z.ZodType {
  switch (call.script) {
    case 'create':
    case 'revise':
    case 'price':
    case 'end':
    case 'relist':
    case 'markSold':
    case 'refresh':
      return writeResult;
    case 'read':
      return listingState;
    case 'health':
      // The signed-in seller, or `null` when the page didn't show one; a runtime older than the
      // seller's read returns nothing, which JSON leaves out (unknown, as `null`).
      return z
        .string()
        .min(1)
        .max(255)
        .transform((handle) => sellerIdentity(handle))
        .or(
          z
            .undefined()
            .or(z.null())
            .transform(() => null),
        );
    case 'orders':
      return orders;
    case 'listings':
      return z.object({
        listings: z.array(listedListing).max(200),
        next: z.string().min(1).max(500).nullable(),
      });
    case 'labels':
      return labels;
    case 'offers':
      return z.array(offer).max(500);
    case 'offer':
      return offerState;
    case 'answerOffer':
      return offerAnswer;
  }
}

/**
 * The phone's answer for `call`, as the session run a runner would have returned. `answer` is
 * the JSON the app sent, or the transcript's stored copy of it.
 */
export function readPhoneAnswer(call: ScriptCall, answer: unknown): SessionRun<unknown> {
  const run = z
    .discriminatedUnion('type', [
      z.object({ type: z.literal('no_session') }),
      // The app could not run the call at all (its web views failed): what went wrong, in its words.
      z.object({ type: z.literal('not_run'), message }),
      z.object({
        type: z.literal('ran'),
        result: z.object({
          ok: z.boolean(),
          value: z.unknown().optional(),
          failure: failure.optional(),
          mutated: z.boolean(),
          steps: z.array(short).max(100),
          stepMs: z.array(z.number().min(0).max(86_400_000)).max(100).optional(),
        }),
      }),
    ])
    .safeParse(answer);
  if (!run.success) return unreadable(call);
  if (run.data.type === 'no_session') return { type: 'no_session' };
  if (run.data.type === 'not_run') return notRun(call, run.data.message);
  const { result } = run.data;
  if (result.ok) {
    const value = valueSchema(call).safeParse(result.value);
    if (!value.success) return unreadable(call);
    const ok: ScriptResult<unknown> = {
      ok: true,
      value: value.data,
      mutated: result.mutated,
      steps: result.steps,
      ...stepTimes(result),
    };
    return { type: 'ran', result: ok };
  }
  if (result.failure === undefined) return unreadable(call);
  const stopped: ScriptResult<unknown> = {
    ok: false,
    mutated: result.mutated,
    steps: result.steps,
    ...stepTimes(result),
    // The phone keeps no screenshots; only the runner names its own.
    failure: { ...result.failure, screenshotKey: null },
  };
  return { type: 'ran', result: stopped };
}

/** The phone's step times, when it sent one per step (a runtime older than them sends none). */
function stepTimes(result: { steps: string[]; stepMs?: number[] | undefined }): {
  stepMs?: number[];
} {
  return result.stepMs?.length === result.steps.length ? { stepMs: result.stepMs } : {};
}

/**
 * What the page had instead, when the phone's run stopped at a page its script no longer
 * understands (safety/evidence.ts): only for the log line, so it is read apart from the answer
 * and never kept with the run.
 */
export function readPhoneEvidence(answer: unknown): PageEvidence | null {
  const read = z
    .object({ result: z.object({ failure: z.object({ evidence: pageEvidenceSchema }) }) })
    .safeParse(answer);
  return read.success ? read.data.result.failure.evidence : null;
}

/**
 * A call the app could not run on the phone: the phone's failure, with its reason, and maybe a
 * change (for a write that stopped part way), so the work fails visibly and is tried again later
 * instead of waiting on a run that will never answer.
 */
function notRun(call: ScriptCall, reason: string): SessionRun<unknown> {
  return {
    type: 'ran',
    result: {
      ok: false,
      mutated: isWriteCall(call),
      steps: [],
      failure: {
        kind: 'error',
        step: 'phone',
        code: 'browser_unavailable',
        message: `the phone could not run this: ${reason}`.slice(0, 200),
        retryAfterMs: null,
        screenshotKey: null,
      },
    },
  };
}

/** An answer the server can't read: the phone's failure, and maybe a change (for a write). */
function unreadable(call: ScriptCall): SessionRun<unknown> {
  return {
    type: 'ran',
    result: {
      ok: false,
      mutated: isWriteCall(call),
      steps: [],
      failure: {
        kind: 'error',
        step: 'phone',
        code: 'script_error',
        message: 'the phone sent an answer Listora could not read',
        retryAfterMs: null,
        screenshotKey: null,
      },
    },
  };
}
