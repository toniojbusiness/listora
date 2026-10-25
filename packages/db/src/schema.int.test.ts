import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CURRENCY_CODES } from './values.ts';
import * as values from './values.ts';
import type { Database } from './schema.ts';
import { createMigratedDatabase, type MigratedDatabase } from './test-support.ts';

/**
 * The columns of every table and view in `Database`. The type below makes this list complete
 * (a column added to an interface but not here fails the type check), and the test compares
 * it with the live schema, so the hand-maintained types cannot drift from the migrations.
 */
const COLUMNS = {
  account: ['id', 'name', 'sku_prefix', 'created_at', 'updated_at'],
  app_user: [
    'id',
    'auth_provider',
    'auth_subject',
    'email',
    'display_name',
    'created_at',
    'updated_at',
  ],
  membership: ['account_id', 'user_id', 'role', 'created_at', 'updated_at'],
  sku_sequence: ['account_id', 'next_number', 'created_at', 'updated_at'],
  storage_location: ['id', 'account_id', 'code', 'label', 'parent_id', 'created_at', 'updated_at'],
  inventory_item: [
    'id',
    'account_id',
    'sku',
    'status',
    'title',
    'brand',
    'product_name',
    'style_number',
    'rn_number',
    'upc',
    'department',
    'category',
    'size_label',
    'size_system',
    'colors',
    'pattern',
    'materials',
    'condition',
    'condition_notes',
    'flaws',
    'keywords',
    'description',
    'measurements',
    'attributes',
    'currency',
    'list_price_cents',
    'floor_price_cents',
    'cost_cents',
    'purchase_date',
    'purchase_source',
    'storage_location_id',
    'quantity',
    'accepted_analysis_id',
    'field_provenance',
    'version',
    'created_at',
    'updated_at',
    'pre_archive_status',
  ],
  photo: [
    'id',
    'account_id',
    'item_id',
    'position',
    'role',
    'storage_key',
    'width',
    'height',
    'sha256',
    'phash',
    'derivatives',
    'ocr_lines',
    'barcodes',
    'created_at',
    'updated_at',
    'status',
    'failure_reason',
    'processed_at',
  ],
  upload_session: ['id', 'account_id', 'expires_at', 'created_at', 'updated_at'],
  upload_file: [
    'id',
    'account_id',
    'session_id',
    'position',
    'content_type',
    'byte_size',
    'sha256',
    'storage_key',
    'status',
    'uploaded_at',
    'attached_at',
    'created_at',
    'updated_at',
  ],
  ai_analysis: [
    'id',
    'account_id',
    'item_id',
    'photo_set_hash',
    'tier',
    'model',
    'status',
    'output',
    'error_code',
    'error_message',
    'created_at',
    'updated_at',
    'requested_by_user_id',
    'escalated_from_analysis_id',
    'attempts',
    'error_retryable',
    'completed_at',
  ],
  ai_usage_event: [
    'id',
    'account_id',
    'user_id',
    'item_id',
    'purpose',
    'provider',
    'model',
    'input_tokens',
    'output_tokens',
    'cache_read_tokens',
    'cache_write_tokens',
    'images',
    'web_searches',
    'cost_micros',
    'price_table_version',
    'latency_ms',
    'created_at',
    'tier',
    'outcome',
    'error_code',
    'batch',
  ],
  ai_usage_daily: [
    'account_id',
    'usage_date',
    'calls',
    'input_tokens',
    'output_tokens',
    'cache_read_tokens',
    'cache_write_tokens',
    'images',
    'web_searches',
    'cost_micros',
    'created_at',
    'updated_at',
    'failed_calls',
  ],
  ai_kill_switch: ['singleton', 'engaged', 'changed_by', 'reason', 'created_at', 'updated_at'],
  ai_account_block: ['account_id', 'blocked_by', 'reason', 'created_at'],
  ai_control_audit: ['id', 'action', 'account_id', 'actor', 'reason', 'created_at'],
  marketplace_connection: [
    'id',
    'account_id',
    'marketplace',
    'mode',
    'external_user_id',
    'display_name',
    'token_ciphertext',
    'access_expires_at',
    'refresh_expires_at',
    'scopes',
    'status',
    'last_ok_at',
    'last_error',
    'created_at',
    'updated_at',
    'granted_at',
    'last_error_code',
    'last_error_at',
    'orders_polled_through',
  ],
  connection_authorization: [
    'id',
    'account_id',
    'user_id',
    'marketplace',
    'state_sha256',
    'callback_at',
    'status',
    'connection_id',
    'failure_code',
    'failure_message',
    'expires_at',
    'completed_at',
    'created_at',
    'updated_at',
  ],
  marketplace_listing: [
    'id',
    'account_id',
    'item_id',
    'marketplace',
    'connection_id',
    'status',
    'external_listing_id',
    'external_sku',
    'external_url',
    'title',
    'description',
    'currency',
    'price_cents',
    'category_ref',
    'aspects',
    'listed_at',
    'ended_at',
    'last_verified_at',
    'remote_snapshot',
    'desired_version',
    'applied_version',
    'created_at',
    'updated_at',
    'remote_revision',
    'pending_external_listing_id',
    'pending_remote_revision',
    'user_confirmed_at',
  ],
  marketplace_operation: [
    'id',
    'account_id',
    'listing_id',
    'kind',
    'idempotency_key',
    'desired',
    'status',
    'success_evidence',
    'attempts',
    'next_attempt_at',
    'error_code',
    'error_message',
    'origin',
    'delist_run_id',
    'created_at',
    'updated_at',
    'content',
  ],
  operation_event: [
    'id',
    'account_id',
    'operation_id',
    'from_status',
    'to_status',
    'attempt',
    'error_code',
    'detail',
    'created_at',
  ],
  inbound_event: [
    'id',
    'account_id',
    'source',
    'marketplace',
    'provider_event_id',
    'signature_ok',
    'payload',
    'processed_at',
    'result',
    'error_message',
    'created_at',
    'updated_at',
    'external_user_id',
  ],
  sale: [
    'id',
    'account_id',
    'marketplace',
    'external_order_id',
    'sold_at',
    'currency',
    'shipping_charged_cents',
    'detection_source',
    'inbound_event_id',
    'status',
    'ship_by',
    'created_at',
    'updated_at',
  ],
  sale_item: [
    'id',
    'account_id',
    'sale_id',
    'marketplace',
    'item_id',
    'listing_id',
    'currency',
    'sale_price_cents',
    'created_at',
    'updated_at',
  ],
  delist_run: [
    'id',
    'account_id',
    'sale_id',
    'item_id',
    'status',
    'realerted_at',
    'escalated_at',
    'completed_at',
    'created_at',
    'updated_at',
  ],
  delist_run_listing: [
    'account_id',
    'delist_run_id',
    'listing_id',
    'source',
    'source_id',
    'status',
    'updated_at',
  ],
  user_task: [
    'id',
    'account_id',
    'kind',
    'item_id',
    'listing_id',
    'operation_id',
    'delist_run_id',
    'urgency',
    'deep_link',
    'payload',
    'status',
    'completed_at',
    'created_at',
    'updated_at',
    'sale_id',
  ],
  fee_line: [
    'id',
    'account_id',
    'sale_id',
    'sale_item_id',
    'kind',
    'currency',
    'amount_cents',
    'source',
    'created_at',
    'updated_at',
  ],
  expense: [
    'id',
    'account_id',
    'incurred_on',
    'category',
    'description',
    'currency',
    'amount_cents',
    'created_at',
    'updated_at',
  ],
  pricing_snapshot: [
    'id',
    'account_id',
    'item_id',
    'source',
    'payload',
    'fetched_at',
    'expires_at',
    'created_at',
    'updated_at',
  ],
  subscription: [
    'id',
    'account_id',
    'source',
    'external_id',
    'plan',
    'status',
    'current_period_start',
    'current_period_end',
    'cancel_at_period_end',
    'created_at',
    'updated_at',
  ],
  entitlement: [
    'id',
    'account_id',
    'plan',
    'subscription_id',
    'active_from',
    'active_until',
    'created_at',
    'updated_at',
  ],
  usage_counter: [
    'account_id',
    'metric',
    'period_start',
    'period_end',
    'used',
    'quota',
    'created_at',
    'updated_at',
  ],
  audit_log: [
    'id',
    'account_id',
    'item_id',
    'actor_kind',
    'actor_user_id',
    'action',
    'changes',
    'created_at',
  ],
  idempotency_record: [
    'account_id',
    'key',
    'operation_id',
    'request_hash',
    'response_status',
    'response_body',
    'created_at',
    'expires_at',
  ],
  deleted_identity: ['auth_provider', 'auth_subject_sha256', 'deleted_at'],
  account_deletion: [
    'id',
    'auth_provider',
    'auth_subject_sha256',
    'provider_username',
    'requested_at',
    'identity_deleted_at',
    'attempts',
  ],
  account_deletion_grant: [
    'deletion_id',
    'connection_id',
    'marketplace',
    'token_ciphertext',
    'outcome',
  ],
} as const satisfies { [Table in keyof Database]: readonly (keyof Database[Table])[] };

type MissingColumns = {
  [Table in keyof Database]: Exclude<keyof Database[Table], (typeof COLUMNS)[Table][number]>;
}[keyof Database];
// Fails to compile, naming the column, when an interface has a column missing from COLUMNS.
const columnsAreComplete: [MissingColumns] extends [never] ? true : MissingColumns = true;

/** Each constrained text column and the TypeScript list that must match its CHECK. */
const CHECKED_VALUES: readonly [table: string, column: string, allowed: readonly string[]][] = [
  ['app_user', 'auth_provider', values.AUTH_PROVIDERS],
  ['deleted_identity', 'auth_provider', values.AUTH_PROVIDERS],
  ['account_deletion', 'auth_provider', values.AUTH_PROVIDERS],
  ['account_deletion_grant', 'outcome', values.ACCOUNT_DELETION_GRANT_OUTCOMES],
  ['membership', 'role', values.MEMBERSHIP_ROLES],
  ['inventory_item', 'status', values.ITEM_STATUSES],
  ['inventory_item', 'pre_archive_status', values.PRE_ARCHIVE_ITEM_STATUSES],
  ['photo', 'role', values.PHOTO_ROLES],
  ['photo', 'status', values.PHOTO_STATUSES],
  ['upload_file', 'content_type', values.IMAGE_CONTENT_TYPES],
  ['upload_file', 'status', values.UPLOAD_FILE_STATUSES],
  ['ai_analysis', 'tier', values.ANALYSIS_TIERS],
  ['ai_analysis', 'status', values.ANALYSIS_STATUSES],
  ['ai_usage_event', 'provider', values.AI_PROVIDERS],
  ['ai_usage_event', 'tier', values.ANALYSIS_TIERS],
  ['ai_usage_event', 'outcome', values.AI_USAGE_OUTCOMES],
  ['ai_control_audit', 'action', values.AI_CONTROL_ACTIONS],
  ['marketplace_connection', 'mode', values.CONNECTION_MODES],
  ['marketplace_connection', 'status', values.CONNECTION_STATUSES],
  ['connection_authorization', 'status', values.CONNECTION_AUTHORIZATION_STATUSES],
  ['marketplace_listing', 'status', values.LISTING_STATUSES],
  ['marketplace_operation', 'kind', values.OPERATION_KINDS],
  ['marketplace_operation', 'status', values.OPERATION_STATUSES],
  ['marketplace_operation', 'success_evidence', values.SUCCESS_EVIDENCE],
  ['marketplace_operation', 'origin', values.OPERATION_ORIGINS],
  ['operation_event', 'from_status', values.OPERATION_STATUSES],
  ['operation_event', 'to_status', values.OPERATION_STATUSES],
  ['user_task', 'kind', values.USER_TASK_KINDS],
  ['user_task', 'urgency', values.USER_TASK_URGENCIES],
  ['user_task', 'status', values.USER_TASK_STATUSES],
  ['inbound_event', 'source', values.INBOUND_EVENT_SOURCES],
  ['inbound_event', 'result', values.INBOUND_EVENT_RESULTS],
  ['sale', 'detection_source', values.SALE_DETECTION_SOURCES],
  ['sale', 'status', values.SALE_STATUSES],
  ['delist_run', 'status', values.DELIST_RUN_STATUSES],
  ['fee_line', 'kind', values.FEE_KINDS],
  ['fee_line', 'source', values.FEE_SOURCES],
  ['pricing_snapshot', 'source', values.PRICING_SOURCES],
  ['subscription', 'source', values.SUBSCRIPTION_SOURCES],
  ['subscription', 'status', values.SUBSCRIPTION_STATUSES],
  ['subscription', 'plan', values.PLANS],
  ['entitlement', 'plan', values.PLANS],
  ['audit_log', 'actor_kind', values.AUDIT_ACTOR_KINDS],
];

/** Parses the literals out of a normalized `CHECK ((col = ANY (ARRAY['a'::text, ...])))`. */
function literalsIn(definition: string): string[] {
  return [...definition.matchAll(/'([^']*)'::text/g)].map((match) => match[1] ?? '');
}

describe('schema types and values match the database', () => {
  let database: MigratedDatabase;

  beforeAll(async () => {
    database = await createMigratedDatabase('schema');
  });

  afterAll(async () => {
    await database.close();
  });

  it('declares exactly the tables, views, and columns the migrations create', async () => {
    expect(columnsAreComplete).toBe(true);
    const { rows } = await sql<{ table_name: string; column_name: string }>`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public' and table_name not like 'kysely_migration%'
      order by table_name, ordinal_position
    `.execute(database.db);
    const live: Record<string, string[]> = {};
    for (const row of rows) (live[row.table_name] ??= []).push(row.column_name);

    const declared = Object.fromEntries(
      Object.entries(COLUMNS).map(([table, columns]) => [table, [...columns]]),
    );
    expect(live).toEqual(declared);
  });

  it.each(CHECKED_VALUES)(
    '%s.%s allows exactly the values in values.ts',
    async (table, column, allowed) => {
      // Postgres prints `in (...)` as `= ANY (ARRAY[...])`, or as `= '...'` for one value.
      const { rows } = await sql<{ definition: string }>`
      select pg_get_constraintdef(oid) as definition from pg_constraint
      where conrelid = ${table}::regclass and contype = 'c'
        and (pg_get_constraintdef(oid) like ${`CHECK ((${column} = ANY (ARRAY[%`}
          or pg_get_constraintdef(oid) ~ ${`^CHECK \\(\\(${column} = '[^']*'::text\\)\\)$`})
    `.execute(database.db);
      expect(rows).toHaveLength(1);
      expect(literalsIn(rows[0]?.definition ?? '')).toEqual([...allowed]);
    },
  );

  it.each([
    ['marketplace_id', values.MARKETPLACES],
    ['currency_code', CURRENCY_CODES],
  ])('domain %s allows exactly the values in values.ts', async (domain, allowed) => {
    const { rows } = await sql<{ definition: string }>`
      select pg_get_constraintdef(c.oid) as definition
      from pg_constraint c join pg_type t on t.oid = c.contypid
      where t.typname = ${domain}
    `.execute(database.db);
    expect(rows).toHaveLength(1);
    expect(literalsIn(rows[0]?.definition ?? '')).toEqual([...allowed]);
  });

  it('maintains updated_at with a trigger on every table that has the column', async () => {
    const { rows } = await sql<{ table_name: string; has_trigger: boolean }>`
      select c.table_name,
        exists (
          select 1 from pg_trigger t
          where t.tgrelid = c.table_name::regclass
            and t.tgname = c.table_name || '_set_updated_at'
        ) as has_trigger
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = 'public' and c.column_name = 'updated_at'
        and t.table_type = 'BASE TABLE'
      order by c.table_name
    `.execute(database.db);
    expect(rows.length).toBeGreaterThan(20);
    expect(rows.filter((row) => !row.has_trigger)).toEqual([]);
  });

  // Platform tables hold settings and history that belong to no single tenant.
  it('gives every table except the global identity and platform tables a non-null tenant account_id', async () => {
    const { rows } = await sql<{ table_name: string }>`
      select t.table_name from information_schema.tables t
      where t.table_schema = 'public' and t.table_type = 'BASE TABLE'
        and t.table_name not like 'kysely_migration%'
        and t.table_name not in (
          'account', 'app_user', 'deleted_identity', 'account_deletion', 'account_deletion_grant',
          'ai_kill_switch', 'ai_control_audit'
        )
        and not exists (
          select 1 from information_schema.columns c
          where c.table_schema = t.table_schema and c.table_name = t.table_name
            and c.column_name = 'account_id' and c.is_nullable = 'NO'
        )
    `.execute(database.db);
    expect(rows).toEqual([]);
  });
});
