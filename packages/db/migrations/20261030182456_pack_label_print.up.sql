-- Printing the shipping label with the order's item stickers (docs/features/pack-check.md,
-- "Printing the label"): where the marketplace offers the label's file, and Listora's prints of
-- it, for the warning before a second print.

-- The label's file (a PDF) on the marketplace's own site, as its order page names it (https; a
-- local stand-in's http in development). The phone downloads it through the seller's session to
-- print it; Listora's server never fetches or keeps the file, which shows the buyer's name and
-- address.
alter table sale_label add column label_file_url text
  check (label_file_url ~ '^https?://' and char_length(label_file_url) <= 2048);
-- The label Listora last printed for the order, when, and how many times: printing the same label
-- again warns first. A print of another label (the marketplace made a new one) starts over.
alter table sale_label add column printed_tracking_number text
  check (char_length(printed_tracking_number) between 1 and 40);
alter table sale_label add column printed_at timestamptz;
alter table sale_label add column print_count integer not null default 0
  check (print_count >= 0);
alter table sale_label add constraint sale_label_printed
  check ((printed_tracking_number is null) = (printed_at is null));
