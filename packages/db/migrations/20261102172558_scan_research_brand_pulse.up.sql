-- The thrift scan's brand pulse (docs/features/thrift-scan.md, "Brand pulse"): what the wider
-- web says of a brand (in demand, steady, or slow, with why, and which lines or eras ask more),
-- kept per account by the brand alone like a brand's other facts, so a brand costs one search a
-- week however often it is scanned.
alter table scan_research
  drop constraint scan_research_kind_check,
  add constraint scan_research_kind_check check (kind in ('item', 'brand', 'brand_pulse'));
