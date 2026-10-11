-- Public read layer (Phase 2). Users read curated views only:
--   public_realtors          the realtor directory (from the DRE bulk file)
--   public_dre_records       one row per licensee: DRE page facts
--   public_dre_affiliations  brokers / roles / DBAs over time
--   public_dre_actions       discipline comments + links to DRE's hearing documents
-- Internal columns (fingerprints, source raw file, parser version, unplaced
-- lines, page encoding) are left out. Raw tables stay server-only.
-- Views run with the owner's rights on purpose: they expose exactly these
-- columns to anon/authenticated and nothing else.

-- Direct reads of `realtors` go through public_realtors instead.
revoke select on public.realtors from anon, authenticated;

create view public.public_realtors as
select
  r.license_number,
  r.full_name,
  r.first_name,
  r.last_name,
  r.name_suffix,
  r.license_type,
  r.license_status,
  (r.license_status = 'Licensed NBA') as is_non_working,
  r.restricted_license,
  r.license_effective_date,
  r.license_expiration_date,
  r.original_license_date,
  r.employing_broker_license_number,
  r.employing_broker_name,
  r.officer_of,
  r.city,
  r.county,
  r.in_current_dre_file,
  -- "Last confirmed in DRE's list": the latest succeeded refresh for realtors
  -- still in the file; the last time we saw them otherwise.
  case when r.in_current_dre_file
       then coalesce((select max(started_at) from public.dre_ingest_runs where status = 'succeeded'), r.last_seen_in_dre_file_at)
       else r.last_seen_in_dre_file_at end as dre_last_confirmed_at,
  r.search_vector
from public.realtors r;

create view public.public_dre_records as
select
  license_number, dre_records_as_of, license_type, name_as_listed, license_status_raw,
  is_restricted, is_non_working, expiration_date, expiration_note,
  salesperson_license_issued, broker_license_issued, issued_dates_unofficial,
  mlo_nmls_id, company_mlo_nmls_id, former_names,
  salespersons_count_reported, broker_associates_count_reported
from public.dre_licensee_records;

create view public.public_dre_affiliations as
select
  license_number, seq, kind, is_current, related_license_number, related_name,
  from_date, to_date, related_expiration_date, ended_status, ended_on,
  officer_restricted, corporation_restricted, raw_text
from public.dre_affiliations;

create view public.public_dre_actions as
select license_number, seq, kind, action_date, text_verbatim, document_url
from public.dre_actions;

-- Supabase grants new views ALL privileges to anon/authenticated by default,
-- and simple views are auto-updatable: without this revoke, users could
-- delete or edit the underlying tables through the views. Read-only only.
revoke all on public.public_realtors, public.public_dre_records, public.public_dre_affiliations, public.public_dre_actions
  from anon, authenticated;
grant select on public.public_realtors, public.public_dre_records, public.public_dre_affiliations, public.public_dre_actions
  to anon, authenticated;
