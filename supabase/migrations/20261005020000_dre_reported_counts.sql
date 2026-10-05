-- Large brokers: DRE shows "There are currently N Salespersons affiliated with
-- this Broker/Corporation" instead of listing them (parser v3).
alter table public.dre_licensee_records
  add column salespersons_count_reported integer,
  add column broker_associates_count_reported integer;

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
      mlo_nmls_id, company_mlo_nmls_id, former_names, salespersons_count_reported, broker_associates_count_reported, unparsed_lines)
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
      (r ->> 'salespersons_count_reported')::int, (r ->> 'broker_associates_count_reported')::int,
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
      salespersons_count_reported = excluded.salespersons_count_reported,
      broker_associates_count_reported = excluded.broker_associates_count_reported,
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

revoke execute on function public.dre_apply_parsed(jsonb) from public, anon, authenticated;
