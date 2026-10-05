-- Processed layer for DRE licensee pages (relational).
--
-- Built by scripts/process-dre-pages.mts from the raw layer (dre-raw bucket +
-- raw_dre_page_fetches); never from DRE directly. Every row records the raw
-- fetch it came from and the parser version, so the whole layer can be
-- rebuilt from raw at any time. Keyed by DRE license number; joins to
-- `realtors` (bulk file) on license_number once that is loaded.
--
-- Server-only for now (RLS on, no grants); opened for public reading when the
-- site's UI is built.

-- One row per licensee: facts DRE shows once per page.
create table public.dre_licensee_records (
  license_number              text primary key check (license_number ~ '^[0-9]{8}$'),
  source_fetch_id             bigint not null references public.raw_dre_page_fetches (id),
  parser_version              integer not null,
  processed_at                timestamptz not null default now(),
  dre_records_as_of           timestamptz,           -- DRE's own "records as of" stamp
  page_encoding               text not null,
  license_type                text not null,          -- verbatim: BROKER / SALESPERSON
  name_as_listed              text not null,
  license_status_raw          text not null,          -- verbatim, e.g. 'LICENSED NBA *** RESTRICTED ***'
  is_restricted               boolean not null,
  is_non_working              boolean not null,       -- NBA: may not perform licensed acts
  expiration_date             date,
  expiration_note             text,                   -- e.g. 'License Extension granted through 10/19/26'
  salesperson_license_issued  date,
  broker_license_issued       date,
  issued_dates_unofficial     boolean not null default false,
  mlo_nmls_id                 text,
  company_mlo_nmls_id         text,
  former_names                text[] not null default '{}',
  -- Lines the parser couldn't place, kept verbatim ([{label, line}]).
  unparsed_lines              jsonb not null default '[]' check (jsonb_typeof(unparsed_lines) = 'array')
);

-- Relationships over time: brokers, broker-associate roles, officer roles,
-- branch-manager roles, supervised licensees, DBAs.
create table public.dre_affiliations (
  id                        bigint generated always as identity primary key,
  license_number            text not null references public.dre_licensee_records (license_number) on delete cascade,
  seq                       integer not null,
  kind                      text not null check (kind in (
                              'responsible_broker', 'broker_associate_for', 'officer_of_corporation', 'branch_manager_for',
                              'supervised_salesperson', 'supervised_broker_associate', 'dba')),
  is_current                boolean not null,
  related_license_number    text check (related_license_number ~ '^[0-9]{8}$'),
  related_name              text,
  from_date                 date,
  to_date                   date,
  related_expiration_date   date,
  ended_status              text check (ended_status in ('expired', 'canceled')),
  ended_on                  date,
  officer_restricted        boolean,
  corporation_restricted    boolean,
  raw_text                  text not null,          -- DRE's lines for this entry, addresses removed
  unique (license_number, seq)
);

create index dre_affiliations_related_idx on public.dre_affiliations (related_license_number);
create index dre_affiliations_kind_idx on public.dre_affiliations (kind, is_current);

-- Discipline / public comments (verbatim, dated) and hearing-document links.
create table public.dre_actions (
  id              bigint generated always as identity primary key,
  license_number  text not null references public.dre_licensee_records (license_number) on delete cascade,
  seq             integer not null,
  kind            text not null check (kind in ('comment', 'document')),
  action_date     date,
  text_verbatim   text not null,
  document_url    text,                               -- DRE's copy; we link, never host
  unique (license_number, seq)
);

-- One row per processing run.
create table public.dre_process_runs (
  id                   bigint generated always as identity primary key,
  started_at           timestamptz not null default now(),
  finished_at          timestamptz,
  status               text not null default 'running' check (status in ('running', 'completed', 'failed')),
  runner               text,
  parser_version       integer not null,
  pages_considered     integer,
  pages_processed      integer not null default 0,
  pages_skipped        integer not null default 0,      -- already processed from the same raw file + parser
  pages_failed         integer not null default 0,
  pages_with_unparsed  integer not null default 0,
  affiliation_rows     integer not null default 0,
  action_rows          integer not null default 0,
  error                text
);

-- Atomically replace the processed rows for a group of licensees:
-- p = [{record: {...}, affiliations: [...], actions: [...]}, ...]
create or replace function public.dre_apply_parsed(p jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  item jsonb;
  r jsonb;
  n integer := 0;
begin
  for item in select * from jsonb_array_elements(p) loop
    r := item -> 'record';
    insert into public.dre_licensee_records as t (
      license_number, source_fetch_id, parser_version, processed_at, dre_records_as_of, page_encoding,
      license_type, name_as_listed, license_status_raw, is_restricted, is_non_working,
      expiration_date, expiration_note, salesperson_license_issued, broker_license_issued, issued_dates_unofficial,
      mlo_nmls_id, company_mlo_nmls_id, former_names, unparsed_lines)
    values (
      r ->> 'license_number', (r ->> 'source_fetch_id')::bigint, (r ->> 'parser_version')::int, now(),
      case when r ->> 'dre_records_as_of' is null then null
           else to_timestamp(r ->> 'dre_records_as_of', 'MM/DD/YYYY HH12:MI:SS AM')::timestamp at time zone 'America/Los_Angeles' end,
      r ->> 'page_encoding', r ->> 'license_type', r ->> 'name_as_listed', r ->> 'license_status_raw',
      (r ->> 'is_restricted')::boolean, (r ->> 'is_non_working')::boolean,
      (r ->> 'expiration_date')::date, r ->> 'expiration_note',
      (r ->> 'salesperson_license_issued')::date, (r ->> 'broker_license_issued')::date, (r ->> 'issued_dates_unofficial')::boolean,
      r ->> 'mlo_nmls_id', r ->> 'company_mlo_nmls_id',
      coalesce((select array_agg(x) from jsonb_array_elements_text(r -> 'former_names') x), '{}'),
      coalesce(r -> 'unparsed_lines', '[]'))
    on conflict (license_number) do update set
      source_fetch_id = excluded.source_fetch_id, parser_version = excluded.parser_version, processed_at = excluded.processed_at,
      dre_records_as_of = excluded.dre_records_as_of, page_encoding = excluded.page_encoding,
      license_type = excluded.license_type, name_as_listed = excluded.name_as_listed, license_status_raw = excluded.license_status_raw,
      is_restricted = excluded.is_restricted, is_non_working = excluded.is_non_working,
      expiration_date = excluded.expiration_date, expiration_note = excluded.expiration_note,
      salesperson_license_issued = excluded.salesperson_license_issued, broker_license_issued = excluded.broker_license_issued,
      issued_dates_unofficial = excluded.issued_dates_unofficial, mlo_nmls_id = excluded.mlo_nmls_id,
      company_mlo_nmls_id = excluded.company_mlo_nmls_id, former_names = excluded.former_names,
      unparsed_lines = excluded.unparsed_lines;

    delete from public.dre_affiliations where license_number = r ->> 'license_number';
    delete from public.dre_actions where license_number = r ->> 'license_number';

    insert into public.dre_affiliations (license_number, seq, kind, is_current, related_license_number, related_name,
      from_date, to_date, related_expiration_date, ended_status, ended_on, officer_restricted, corporation_restricted, raw_text)
    select r ->> 'license_number', a.seq, a.kind, a.is_current, a.related_license_number, a.related_name,
      a.from_date, a.to_date, a.related_expiration_date, a.ended_status, a.ended_on, a.officer_restricted, a.corporation_restricted, a.raw_text
    from jsonb_to_recordset(coalesce(item -> 'affiliations', '[]')) as a(
      seq int, kind text, is_current boolean, related_license_number text, related_name text, from_date date, to_date date,
      related_expiration_date date, ended_status text, ended_on date, officer_restricted boolean, corporation_restricted boolean, raw_text text);

    insert into public.dre_actions (license_number, seq, kind, action_date, text_verbatim, document_url)
    select r ->> 'license_number', a.seq, a.kind, a.action_date, a.text_verbatim, a.document_url
    from jsonb_to_recordset(coalesce(item -> 'actions', '[]')) as a(
      seq int, kind text, action_date date, text_verbatim text, document_url text);

    n := n + 1;
  end loop;
  return n;
end $$;

alter table public.dre_licensee_records enable row level security;
alter table public.dre_affiliations     enable row level security;
alter table public.dre_actions          enable row level security;
alter table public.dre_process_runs     enable row level security;

revoke all on public.dre_licensee_records, public.dre_affiliations, public.dre_actions, public.dre_process_runs
  from anon, authenticated;
revoke execute on function public.dre_apply_parsed(jsonb) from public, anon, authenticated;
