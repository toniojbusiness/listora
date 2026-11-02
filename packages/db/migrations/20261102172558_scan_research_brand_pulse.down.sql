delete from scan_research where kind = 'brand_pulse';

alter table scan_research
  drop constraint scan_research_kind_check,
  add constraint scan_research_kind_check check (kind in ('item', 'brand'));
