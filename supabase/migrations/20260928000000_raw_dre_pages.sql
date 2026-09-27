-- Raw layer for DRE data (exact bytes as received; nothing interpreted).
--
-- Files live in the private Storage bucket 'dre-raw':
--   bulk/<fetched_at>/CurrList.zip          the DRE bulk file, as downloaded
--   pages/<license>/<fetched_at>.html.gz    one licensee lookup page (gzip is
--                                           lossless; sha256_raw is of the
--                                           uncompressed bytes)
-- These tables are the index/receipt log of those files. They are server-only:
-- RLS on, no policies, no grants to anon/authenticated. Only the secret key
-- (the fetch job) can read or write them. Kept in `public` with a `raw_`
-- prefix because Supabase's API only reaches exposed schemas.

insert into storage.buckets (id, name, public, file_size_limit)
values ('dre-raw', 'dre-raw', false, 52428800)
on conflict (id) do nothing;

create table public.raw_dre_bulk_files (
  id            bigint generated always as identity primary key,
  fetched_at    timestamptz not null default now(),
  source_url    text not null,
  http_status   integer not null,
  byte_size     integer not null,
  sha256_raw    text not null check (sha256_raw ~ '^[0-9a-f]{64}$'),
  storage_path  text not null unique
);

create table public.raw_dre_fetch_batches (
  id                    bigint generated always as identity primary key,
  started_at            timestamptz not null default now(),
  finished_at           timestamptz,
  last_heartbeat_at     timestamptz not null default now(),
  -- running: in progress (heartbeat updated every ~15 s)
  -- completed: every planned page attempted
  -- stopped: halted by a guardrail (slowdown, block, errors, time limit, cancel)
  -- failed: crashed
  -- abandoned: heartbeat went silent (runner died); found by the next run
  status                text not null default 'running'
                        check (status in ('running', 'completed', 'stopped', 'failed', 'abandoned')),
  stop_reason           text,
  runner                text,           -- e.g. 'github-actions run 123 attempt 1' or 'local'
  bulk_file_id          bigint references public.raw_dre_bulk_files (id),
  planned_count         integer,
  attempted             integer not null default 0,
  ok_count              integer not null default 0,
  not_found_count       integer not null default 0,
  incomplete_count      integer not null default 0,
  error_count           integer not null default 0,
  baseline_ms           integer,        -- DRE response time measured at the start
  median_ms             integer,
  p90_ms                integer,
  current_concurrency   integer,
  max_concurrency_used  integer,
  settings              jsonb not null default '{}'
);

create table public.raw_dre_page_fetches (
  id                bigint generated always as identity primary key,
  batch_id          bigint not null references public.raw_dre_fetch_batches (id),
  license_number    text not null check (license_number ~ '^[0-9]{8}$'),
  requested_url     text not null,
  fetched_at        timestamptz not null default now(),
  duration_ms       integer,
  attempts          smallint not null default 1,
  http_status       integer,
  response_headers  jsonb,
  byte_size         integer,
  sha256_raw        text check (sha256_raw ~ '^[0-9a-f]{64}$'),
  storage_path      text unique,
  -- ok:            complete page ("Public information request complete")
  -- not_found:     DRE's "No matching public record was found" page
  -- incomplete:    HTTP 200 but neither marker (truncated / unexpected page)
  -- http_error:    non-200 response
  -- network_error: timeout / connection failure after retries
  -- verify_failed: the stored file did not match what was received (it is
  --                fetched again by a later batch)
  outcome           text not null
                    check (outcome in ('ok', 'not_found', 'incomplete', 'http_error', 'network_error', 'verify_failed')),
  error             text,
  -- Set once the stored file was downloaded back and its checksum matched.
  verified_at       timestamptz,
  check ((storage_path is null) = (outcome in ('http_error', 'network_error')))
);

create index raw_dre_page_fetches_license_idx on public.raw_dre_page_fetches (license_number, outcome);
create index raw_dre_page_fetches_batch_idx on public.raw_dre_page_fetches (batch_id);
create index raw_dre_page_fetches_unverified_idx on public.raw_dre_page_fetches (id)
  where verified_at is null and storage_path is not null and outcome <> 'verify_failed';

alter table public.raw_dre_bulk_files     enable row level security;
alter table public.raw_dre_fetch_batches  enable row level security;
alter table public.raw_dre_page_fetches   enable row level security;

-- New tables get Supabase's default grants; take them away.
revoke all on public.raw_dre_bulk_files, public.raw_dre_fetch_batches, public.raw_dre_page_fetches
  from anon, authenticated;
