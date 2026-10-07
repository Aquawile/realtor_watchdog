-- Weekly fingerprint refresh of `realtors` from the DRE bulk file: each row
-- stores a SHA-256 of its DRE bulk-file data; only rows whose fingerprint
-- changed are rewritten. Each ingestion run records which raw bulk file it used.
alter table public.realtors add column dre_fingerprint text check (dre_fingerprint ~ '^[0-9a-f]{64}$');

alter table public.dre_ingest_runs
  add column bulk_file_id bigint references public.raw_dre_bulk_files (id),
  add column unchanged    integer;
