-- Vinted's shipping labels in Pack check (docs/features/vinted.md, "Shipping labels and Pack
-- check"): SpeedX is one of the carriers a Vinted buyer picks, and a Vinted order's shipment is a
-- label to print or a QR code shown at the carrier's counter, which prints the label there.

alter table sale_label drop constraint sale_label_carrier_check;
alter table sale_label add constraint sale_label_carrier_check
  check (carrier in ('usps', 'ups', 'fedex', 'dhl', 'speedx', 'other'));
-- What the marketplace gives the seller to ship with, when its order page says: `label` (a
-- shipping label the seller prints) or `qr_code` (a code the carrier scans at drop-off, which
-- prints the label there). `null` when the page doesn't say: every marketplace before Vinted.
alter table sale_label add column label_format text
  check (label_format in ('label', 'qr_code'));
