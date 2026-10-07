-- Raw layer bundling: many small raw page files -> a few .tar bundles in the
-- dre-raw bucket. Each Storage object costs ~1.2 KB of database space in
-- Supabase's storage.objects table, so 44k single-page files cost ~50 MB.
-- Page bytes are unchanged inside bundles; receipts keep their checksums and
-- point to (bundle, entry).

create table public.raw_dre_bundles (
  id             bigint generated always as identity primary key,
  created_at     timestamptz not null default now(),
  storage_path   text not null unique,
  byte_size      integer not null,
  sha256         text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  entry_count    integer not null,
  first_license  text,
  last_license   text,
  verified_at    timestamptz           -- every entry re-checked against its receipt after upload
);

alter table public.raw_dre_page_fetches
  add column bundle_id    bigint references public.raw_dre_bundles (id),
  add column bundle_entry text;

-- A stored page lives either as a single file (storage_path) or in a bundle.
alter table public.raw_dre_page_fetches drop constraint if exists raw_dre_page_fetches_check;
alter table public.raw_dre_page_fetches add constraint raw_dre_page_fetches_stored_check check (
  case when outcome in ('http_error', 'network_error') then storage_path is null and bundle_id is null
       else (storage_path is not null) <> (bundle_id is not null) end);
alter table public.raw_dre_page_fetches add constraint raw_dre_page_fetches_bundle_entry_check
  check ((bundle_id is null) = (bundle_entry is null));

create index raw_dre_page_fetches_bundle_idx on public.raw_dre_page_fetches (bundle_id);

-- Point receipts at their bundle entry and clear the single-file path, in one
-- transaction: p = [{id, entry}, ...].
create or replace function public.raw_dre_attach_bundle(p_bundle_id bigint, p jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update public.raw_dre_page_fetches f
     set bundle_id = p_bundle_id, bundle_entry = x.entry, storage_path = null
    from jsonb_to_recordset(p) as x(id bigint, entry text)
   where f.id = x.id and f.storage_path is not null;
  get diagnostics n = row_count;
  if n <> jsonb_array_length(p) then
    raise exception 'expected to attach % receipts, attached %', jsonb_array_length(p), n;
  end if;
  return n;
end $$;

-- Archived raw-layer side files (e.g. fetch headers moved out of the database).
create table public.raw_archives (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  storage_path  text not null unique,
  description   text not null,
  byte_size     integer not null,
  sha256        text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  row_count     integer
);

-- Bulk-file retention: the latest copies are kept; older ones are purged from
-- Storage while their receipt row (tiny) stays for history.
alter table public.raw_dre_bulk_files add column purged_at timestamptz;
alter table public.raw_dre_bulk_files alter column storage_path drop not null;

alter table public.raw_dre_bundles enable row level security;
alter table public.raw_archives    enable row level security;
revoke all on public.raw_dre_bundles, public.raw_archives from anon, authenticated;
revoke execute on function public.raw_dre_attach_bundle(bigint, jsonb) from public, anon, authenticated;
