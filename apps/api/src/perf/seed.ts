/**
 * A synthetic seller for performance work (docs/features/performance.md): one account's
 * inventory, photos, cross-listings, operation history, sales, fees, delist runs, and tasks,
 * written straight into the database with set-based SQL so 2,000 items take about a second.
 * The data is deterministic (hashes of the row number, not a random generator), so two runs
 * measure the same thing. Nothing here goes through the API; the benchmark measures the API.
 */
import type { DbExecutor } from '@listora/db';
import { sql } from 'kysely';

export interface SyntheticSellerOptions {
  /** How many inventory items the seller has (default 2,000). */
  items?: number;
  /** Photos per item (default 6). */
  photosPerItem?: number;
}

export interface SyntheticSellerCounts {
  items: number;
  photos: number;
  listings: number;
  operations: number;
  operationEvents: number;
  sales: number;
  openTasks: number;
}

/**
 * Item statuses by share of the inventory, cumulative percent: a mature reseller with most of
 * the stock listed, a steady flow of sales, and some drafts waiting for review.
 */
const STATUS_BANDS = sql.raw(`case
  when b < 8 then 'draft'
  when b < 15 then 'ready'
  when b < 75 then 'listed'
  when b < 76 then 'sold_pending_delist'
  when b < 78 then 'sold'
  when b < 95 then 'shipped'
  else 'archived' end`);

/**
 * Seeds one seller into `accountId` (which must exist with its `sku_sequence` row, as every
 * account has). Run it once per account: SKUs start at 1.
 */
export async function seedSyntheticSeller(
  db: DbExecutor,
  accountId: string,
  options: SyntheticSellerOptions = {},
): Promise<SyntheticSellerCounts> {
  const items = options.items ?? 2_000;
  const photosPerItem = options.photosPerItem ?? 6;
  const run = (query: ReturnType<typeof sql>) => query.execute(db);

  await run(sql`
    insert into storage_location (account_id, code, label)
    select ${accountId}, 'B-' || lpad(g::text, 2, '0'), 'Bin ' || g::text
    from generate_series(1, 20) g`);

  // eBay through its API, Poshmark and Mercari automated with a linked session, Depop assisted.
  await run(sql`
    insert into marketplace_connection
      (account_id, marketplace, mode, external_user_id, display_name, token_ciphertext, status,
       last_ok_at, granted_at)
    values
      (${accountId}, 'ebay', 'api', 'seller-ebay', 'seller on eBay', '\\x00'::bytea, 'connected', now(), now()),
      (${accountId}, 'poshmark', 'automation', 'seller-posh', 'seller on Poshmark', '\\x00'::bytea, 'connected', now(), now()),
      (${accountId}, 'mercari', 'automation', 'seller-mercari', 'seller on Mercari', '\\x00'::bytea, 'connected', now(), now()),
      (${accountId}, 'depop', 'assisted', null, null, null, 'connected', null, null)`);

  // Items over the last year, oldest first. Ids are UUIDv7 stamped at `created_at`, so id order
  // is creation order exactly as for items made through the API.
  await run(sql`
    with numbered as (
      select g, mod(abs(hashint4(g)), 100) as b,
        now() - make_interval(secs => (${items} - g + 1) * (31536000.0 / ${items})) as created_at
      from generate_series(1, ${items}) g
    ), statused as (
      select numbered.*, ${STATUS_BANDS} as status from numbered
    )
    insert into inventory_item
      (id, account_id, sku, status, pre_archive_status, title, brand, category, size_label,
       colors, materials, condition, keywords, description, list_price_cents, floor_price_cents,
       cost_cents, purchase_date, storage_location_id, created_at, updated_at)
    select uuidv7(created_at - now()), ${accountId},
      (select sku_prefix from account where id = ${accountId}) || '-' || lpad(g::text, 6, '0'),
      case when status = 'archived' then 'archived' else status end,
      case when status = 'archived' then 'shipped' end,
      (array['Levi''s', 'Patagonia', 'Nike', 'Madewell', 'Carhartt', 'Lululemon', 'Coach',
             'J.Crew', 'Zara', 'Free People'])[1 + mod(g, 10)]
        || ' ' || (array['Denim Jacket', 'Fleece Pullover', 'Running Shoes', 'Wide Leg Jeans',
             'Work Jacket', 'Leggings', 'Leather Bag', 'Wool Sweater', 'Midi Dress',
             'Flannel Shirt'])[1 + mod(g / 10, 10)] || ' #' || g::text,
      (array['Levi''s', 'Patagonia', 'Nike', 'Madewell', 'Carhartt', 'Lululemon', 'Coach',
             'J.Crew', 'Zara', 'Free People'])[1 + mod(g, 10)],
      'Clothing', (array['XS', 'S', 'M', 'L', 'XL'])[1 + mod(g, 5)],
      array['blue'], array['cotton'], 'pre_owned_good', array['vintage', 'denim', 'jacket'],
      'A synthetic item for performance measurement, number ' || g::text || '.',
      2000 + mod(abs(hashint4(g + 1)), 8000), 1500, 300 + mod(abs(hashint4(g + 2)), 1500),
      (created_at - interval '3 days')::date,
      (select id from storage_location where account_id = ${accountId}
        order by code offset mod(g, 20) limit 1),
      created_at, created_at
    from statused`);
  await run(sql`
    update sku_sequence set next_number = ${items + 1} where account_id = ${accountId}`);

  await run(sql`
    insert into photo
      (account_id, item_id, position, role, storage_key, width, height, sha256, phash,
       derivatives, status, processed_at, created_at)
    select item.account_id, item.id, p, (array['front', 'back', 'tag', 'detail', 'detail', 'flaw'])[1 + mod(p, 6)],
      'photos/' || item.id || '/' || p || '/original.jpg', 3024, 4032,
      md5(item.id::text || p) || md5(p || item.id::text), substr(md5(item.id::text || p), 1, 16),
      jsonb_build_object(
        'original', jsonb_build_object('key', 'photos/' || item.id || '/' || p || '/original.jpg', 'width', 3024, 'height', 4032, 'byteSize', 1800000, 'sha256', md5(item.id::text || p) || md5(p || item.id::text)),
        'ai', jsonb_build_object('key', 'photos/' || item.id || '/' || p || '/ai.jpg', 'width', 768, 'height', 1024, 'byteSize', 150000, 'sha256', md5(item.id::text || p) || md5(p || item.id::text)),
        'thumbnail', jsonb_build_object('key', 'public/' || md5(item.id::text || p) || '/thumbnail.jpg', 'width', 300, 'height', 400, 'byteSize', 30000, 'sha256', md5(item.id::text || p) || md5(p || item.id::text)),
        'listing', jsonb_build_object('key', 'public/' || md5(item.id::text || p) || '/listing.jpg', 'width', 1200, 'height', 1600, 'byteSize', 400000, 'sha256', md5(item.id::text || p) || md5(p || item.id::text))),
      'ready', item.created_at, item.created_at
    from inventory_item item, generate_series(0, ${photosPerItem - 1}) p
    where item.account_id = ${accountId}`);

  // Listings. A listed item is live on eBay and on some of the others; a sold one is sold on
  // one marketplace and ended on the rest; a ready item has an eBay draft.
  await run(sql`
    with item as (
      select id, status, created_at,
        mod(abs(hashint4(hashtext(id::text))), 100) as b,
        coalesce(pre_archive_status, status) as effective
      from inventory_item where account_id = ${accountId}
    ), wanted as (
      select item.*, m.marketplace,
        case
          when item.status = 'ready' then case when m.marketplace = 'ebay' then 'draft' end
          when item.status = 'draft' then null
          when item.status = 'listed' then case
            when m.marketplace = 'ebay' then 'active'
            when m.marketplace = 'poshmark' and item.b < 70 then 'active'
            when m.marketplace = 'mercari' and item.b < 50 then 'active'
            when m.marketplace = 'depop' and item.b < 30 then 'active' end
          else case
            when m.marketplace = (array['ebay', 'ebay', 'poshmark', 'mercari'])[1 + mod(item.b, 4)]
              then 'sold'
            when m.marketplace = 'ebay' or item.b < 60 then 'ended' end
        end as listing_status
      from item cross join (values ('ebay'), ('poshmark'), ('mercari'), ('depop')) m(marketplace)
    )
    insert into marketplace_listing
      (id, account_id, item_id, marketplace, connection_id, status, external_listing_id,
       external_url, title, price_cents, listed_at, ended_at, last_verified_at,
       user_confirmed_at, desired_version, applied_version, created_at, updated_at)
    select uuidv7(wanted.created_at + interval '1 hour' - now()), ${accountId}, wanted.id,
      wanted.marketplace::marketplace_id, connection.id, wanted.listing_status,
      case when wanted.listing_status <> 'draft' then wanted.marketplace || '-' || wanted.id end,
      case when wanted.listing_status <> 'draft'
        then 'https://' || wanted.marketplace || '.example/listing/' || wanted.id end,
      'Listing of item ' || wanted.id, 2500 + mod(wanted.b * 97, 6000),
      case when wanted.listing_status <> 'draft' then wanted.created_at + interval '1 hour' end,
      case when wanted.listing_status in ('ended', 'sold')
        then least(now(), wanted.created_at + interval '20 days') end,
      case when wanted.listing_status <> 'draft' and connection.mode <> 'assisted'
        then wanted.created_at + interval '1 hour' end,
      case when wanted.listing_status <> 'draft' and connection.mode = 'assisted'
        then wanted.created_at + interval '1 hour' end,
      1, 1, wanted.created_at + interval '1 hour', wanted.created_at + interval '1 hour'
    from wanted
    join marketplace_connection connection
      on connection.account_id = ${accountId} and connection.marketplace::text = wanted.marketplace
    where wanted.listing_status is not null`);

  // Operations: every listing that went live was created through the engine and read back; a
  // third had a price change; ended ones were ended. A few failed or are still in flight.
  await run(sql`
    insert into marketplace_operation
      (id, account_id, listing_id, kind, idempotency_key, desired, content, status,
       success_evidence, attempts, next_attempt_at, error_code, error_message, origin,
       created_at, updated_at)
    select uuidv7(op.at - now()), ${accountId}, listing.id, op.kind,
      op.kind || ':' || listing.id, '{}'::jsonb,
      case when op.kind in ('create', 'revise', 'relist') then '{"title": "x"}'::jsonb end,
      op.status, case when op.status = 'succeeded' then 'read_back' end,
      case when op.status in ('failed', 'retrying') then 3 else 1 end,
      case when op.status = 'retrying' then now() + interval '10 minutes' end,
      case when op.status = 'failed' then 'marketplace_unavailable' end,
      case when op.status = 'failed' then 'The marketplace did not respond. Retry.' end,
      'user', op.at, op.at
    from marketplace_listing listing
    cross join lateral (values
      ('create', listing.created_at, 'succeeded'),
      ('price', listing.created_at + interval '9 days',
        case when mod(abs(hashint4(hashtext(listing.id::text))), 100) = 0 then 'failed'
             when mod(abs(hashint4(hashtext(listing.id::text))), 100) = 1 then 'retrying'
             else 'succeeded' end),
      ('end', listing.ended_at, 'succeeded')
    ) op(kind, at, status)
    where listing.account_id = ${accountId} and listing.status <> 'draft'
      and (op.kind = 'create'
        or (op.kind = 'price' and mod(abs(hashint4(hashtext(listing.id::text))), 3) = 0
            and op.at < now())
        or (op.kind = 'end' and listing.status = 'ended'))`);
  await run(sql`
    insert into operation_event (account_id, operation_id, from_status, to_status, attempt, created_at)
    select op.account_id, op.id, step.from_status, step.to_status, 1,
      op.created_at + step.n * interval '2 seconds'
    from marketplace_operation op
    cross join lateral (values
      (0, null, 'queued'), (1, 'queued', 'running'), (2, 'running', 'verifying'),
      (3, 'verifying', op.status)
    ) step(n, from_status, to_status)
    where op.account_id = ${accountId}
      and (step.n < 3 or op.status in ('succeeded', 'failed'))
      and (step.n < 2 or op.status <> 'retrying')`);

  // A sale for every item that sold, on the marketplace whose listing sold.
  await run(sql`
    insert into sale
      (id, account_id, marketplace, external_order_id, sold_at, shipping_charged_cents,
       shipping_cost_cents, detection_source, status, ship_by, confirmed_at, shipped_at,
       created_at, updated_at)
    select uuidv7(sold_at - now()), ${accountId}, listing.marketplace,
      'order-' || listing.id, sold_at, 0, 850,
      case when listing.marketplace = 'ebay' then 'webhook' else 'poll' end,
      case when item.status in ('sold', 'sold_pending_delist') then 'confirmed' else 'shipped' end,
      sold_at + interval '2 days', sold_at,
      case when item.status in ('sold', 'sold_pending_delist') then null else sold_at + interval '1 hour' end,
      sold_at, sold_at
    from marketplace_listing listing
    join inventory_item item on item.account_id = listing.account_id and item.id = listing.item_id
    cross join lateral (select case when item.status in ('sold', 'sold_pending_delist')
        then now() - interval '6 hours' else least(now(), listing.ended_at) end as sold_at) t
    where listing.account_id = ${accountId} and listing.status = 'sold'`);
  await run(sql`
    insert into sale_item (account_id, sale_id, marketplace, item_id, listing_id, sale_price_cents, created_at)
    select sale.account_id, sale.id, sale.marketplace, listing.item_id, listing.id,
      coalesce(listing.price_cents, 3000), sale.created_at
    from sale
    join marketplace_listing listing
      on listing.account_id = sale.account_id and 'order-' || listing.id = sale.external_order_id
    where sale.account_id = ${accountId}`);
  await run(sql`
    insert into fee_line (account_id, sale_id, sale_item_id, kind, amount_cents, source, fee_table_version)
    select sale_item.account_id, sale_item.sale_id, sale_item.id, kind.kind,
      sale_item.sale_price_cents * kind.percent / 100,
      case when sale_item.marketplace = 'ebay' then 'actual' else 'estimated' end,
      case when sale_item.marketplace = 'ebay' then null else 'synthetic-2026' end
    from sale_item cross join (values ('marketplace', 13), ('payment', 3)) kind(kind, percent)
    where sale_item.account_id = ${accountId}`);
  await run(sql`
    insert into delist_run (account_id, sale_id, item_id, status, completed_at, created_at)
    select account_id, sale_id, item_id,
      case when item_status = 'sold_pending_delist' then 'in_progress' else 'completed' end,
      case when item_status = 'sold_pending_delist' then null else created_at + interval '1 minute' end,
      created_at
    from (select sale_item.*, item.status as item_status from sale_item
      join inventory_item item on item.account_id = sale_item.account_id and item.id = sale_item.item_id
      where sale_item.account_id = ${accountId}) s`);

  // Depop listings are assisted: their tasks, done for most, open for the newest.
  await run(sql`
    insert into user_task (account_id, kind, item_id, listing_id, status, completed_at, created_at)
    select listing.account_id, 'list_manually', listing.item_id, listing.id,
      case when row_number() over (order by listing.id desc) <= 40 then 'open' else 'done' end,
      case when row_number() over (order by listing.id desc) <= 40 then null else listing.created_at + interval '1 hour' end,
      listing.created_at
    from marketplace_listing listing
    where listing.account_id = ${accountId} and listing.marketplace = 'depop'`);

  await run(sql`
    insert into audit_log (account_id, item_id, actor_kind, action, changes, created_at)
    select item.account_id, item.id, 'user', 'item.updated', '{"title": {"from": "a", "to": "b"}}'::jsonb,
      item.created_at + n * interval '1 hour'
    from inventory_item item, generate_series(1, 5) n
    where item.account_id = ${accountId}`);

  await run(sql`analyze`);
  const counts = await sql<SyntheticSellerCounts>`
    select
      (select count(*) from inventory_item where account_id = ${accountId})::int as items,
      (select count(*) from photo where account_id = ${accountId})::int as photos,
      (select count(*) from marketplace_listing where account_id = ${accountId})::int as listings,
      (select count(*) from marketplace_operation where account_id = ${accountId})::int as operations,
      (select count(*) from operation_event where account_id = ${accountId})::int as "operationEvents",
      (select count(*) from sale where account_id = ${accountId})::int as sales,
      (select count(*) from user_task where account_id = ${accountId} and status = 'open')::int as "openTasks"
  `.execute(db);
  const row = counts.rows[0];
  if (row === undefined) throw new Error('the synthetic seller counts query returned no row');
  return row;
}
