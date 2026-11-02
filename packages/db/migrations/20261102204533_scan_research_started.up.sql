-- The thrift scan's prices wait for what they rest on (docs/features/thrift-scan.md, "Prices
-- after the facts"): the web research starts the moment the read lands instead of when the app
-- asks, and `research_started_at` claims it, so two API tasks never pay for one scan's lookup
-- twice and a lookup cut off by a restart is started again once its claim is old.
alter table item_scan add column research_started_at timestamptz;
