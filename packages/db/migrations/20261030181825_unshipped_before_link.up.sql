-- Sales to ship from just before linking (docs/features/sales.md, "Sales history"): an order the
-- marketplace said still waits to ship, sold in the week before its connection's sales history
-- ends, is the seller's to ship now, not their history. The ones recorded as history before this
-- become the sale check's (`poll`), so Today asks to ship them. Nothing is delisted or announced
-- for them now: they were recorded already.
update sale
set detection_source = 'poll'
from inbound_event event, sale_check_schedule schedule
where sale.detection_source = 'history'
  and sale.status in ('detected', 'confirmed')
  and event.account_id = sale.account_id
  and event.id = sale.inbound_event_id
  and event.payload ->> 'shipped' = 'false'
  and schedule.account_id = sale.account_id
  and schedule.connection_id::text = event.payload ->> 'connectionId'
  and sale.sold_at >= schedule.history_until - interval '7 days';
