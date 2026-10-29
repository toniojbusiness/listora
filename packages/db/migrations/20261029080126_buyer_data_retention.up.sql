-- Buyer data has a retention limit (docs/features/privacy.md#retention, audit L4).
--
-- The daily retention job clears the buyer's first name and the tracking number of a sale's
-- label, and the tracking number of its package, a set number of days after the sale is done
-- (shipped, canceled, or returned), and the buyer's name on an offer that many days after it
-- closed. The package record stays (that it was packed, how it matched, when), so its tracking
-- number may now be empty.

alter table sale_pack alter column tracking_number drop not null;
