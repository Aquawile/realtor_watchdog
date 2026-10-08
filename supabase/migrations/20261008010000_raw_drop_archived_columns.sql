-- Fetch headers and request URLs were archived to Storage on 2026-10-07
-- (raw_archives: archive/raw_dre_page_fetches_headers_2026-10-07T23:30:29.041Z.jsonl.gz,
-- 44,354 rows, verified). They're fetch bookkeeping, not realtor data, and the
-- URL is rebuildable from the license number.
alter table public.raw_dre_page_fetches drop column requested_url;
alter table public.raw_dre_page_fetches drop column response_headers;

-- Never used for lookups; paths are unique by construction (license + timestamp).
alter table public.raw_dre_page_fetches drop constraint raw_dre_page_fetches_storage_path_key;
