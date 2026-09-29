-- Live monitoring fields on raw DRE fetch batches.
alter table public.raw_dre_fetch_batches
  add column verify_failed_count integer not null default 0,
  add column window_median_ms    integer,        -- DRE median response time in the latest pacing window
  add column window_ratio        numeric(6, 2),  -- that median divided by the baseline (1.00 = normal)
  add column first_license       text,           -- range of licenses in this batch (sorted order)
  add column last_license        text;
