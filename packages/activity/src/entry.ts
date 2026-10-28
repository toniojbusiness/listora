/**
 * One line of an activity timeline (docs/features/activity.md): something that happened to an
 * item, a listing, a sale, or a marketplace connection, from the record that keeps it. Its
 * words are the seller's; its ids and references are what an operator searches with.
 */
import type { Marketplace } from '@listora/db';

/** Who did it. */
export const ACTIVITY_SOURCES = [
  /** Listora's server: the operation engine, the sale intake, the auto-delist. */
  'listora',
  /** Listora's cloud browser (the browser runner). */
  'cloud_browser',
  /** The seller's iPhone, running a marketplace step in their own session. */
  'iphone',
  /** The seller. */
  'you',
  /** The marketplace (an order it reported, a notification it sent). */
  'marketplace',
] as const;
export type ActivitySource = (typeof ACTIVITY_SOURCES)[number];

/** How it went. */
export const ACTIVITY_OUTCOMES = ['succeeded', 'failed', 'in_progress', 'waiting', 'info'] as const;
export type ActivityOutcome = (typeof ACTIVITY_OUTCOMES)[number];

/** Which record it comes from. */
export const ACTIVITY_KINDS = [
  /** An item change (`audit_log`). */
  'item',
  /** A step of a marketplace operation (`operation_event`). */
  'operation',
  /** One browser session on the runner or the phone (`automation_run`). */
  'browser_session',
  /** A sale check, or a read of the seller's sold history (`sale_check_run`). */
  'sale_check',
  /** An order a marketplace reported or a check found (`inbound_event`). */
  'order',
  /** A recorded sale (`sale`). */
  'sale',
  /** The delist after a sale (`delist_run`). */
  'delist',
  /** A task for the seller (`user_task`). */
  'task',
  /** A package Pack check packed, and its photo (`sale_pack`). */
  'package',
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** One step of a browser session, and how long it took. */
export interface ActivityStep {
  name: string;
  durationMs: number | null;
}

export interface ActivityEntry {
  /** `<kind>:<record id>`, stable. */
  id: string;
  at: Date;
  kind: ActivityKind;
  source: ActivitySource;
  outcome: ActivityOutcome;
  marketplace: Marketplace | null;
  /** What happened, in the seller's words. */
  title: string;
  detail: string | null;
  itemId: string | null;
  listingId: string | null;
  operationId: string | null;
  saleId: string | null;
  /** How long it took, for something that ran (a browser session, a sale check). */
  durationMs: number | null;
  /** A browser session's steps, in order. */
  steps: ActivityStep[] | null;
  error: { code: string; message: string } | null;
  /**
   * Where an operator finds more: the browser session's run id, which its log lines carry
   * (`runId`), and whether it kept a redacted screenshot; a sale check's record id.
   */
  reference: { runId: string | null; saleCheckId: string | null; screenshot: boolean } | null;
  /** A package's photo (its storage key), kept for a claim. */
  photoKey: string | null;
}
