-- DRE ingestion support (Phase 4a).
--
-- Brokers' own DRE rows never name a brokerage; the brokerage corporations
-- they are officers of come from separate Officer rows (some brokers are
-- officers of several). Stored as [{"license_number": "...", "name": "..."}].

alter table public.realtors
  add column officer_of jsonb not null default '[]'
    check (jsonb_typeof(officer_of) = 'array');

-- Rebuild the search vector so brokerage search also matches officer corps.
alter table public.realtors drop column search_vector;
alter table public.realtors add column search_vector tsvector generated always as (
  setweight(to_tsvector('simple', coalesce(first_name, '') || ' ' || last_name), 'A') ||
  setweight(to_tsvector('simple', coalesce(employing_broker_name, '')), 'B') ||
  setweight(jsonb_to_tsvector('simple', officer_of, '["string"]'), 'B') ||
  setweight(to_tsvector('simple', license_number), 'A')
) stored;
create index realtors_search_idx on public.realtors using gin (search_vector);

create or replace function public.log_realtor_change()
returns trigger language plpgsql as $$
declare
  tracked text[] := array[
    'last_name', 'first_name', 'name_suffix', 'license_type', 'license_status',
    'license_effective_date', 'license_expiration_date', 'restricted_license',
    'employing_broker_license_number', 'employing_broker_name', 'officer_of',
    'city', 'county', 'in_current_dre_file'];
  o jsonb := to_jsonb(old);
  n jsonb := to_jsonb(new);
  old_diff jsonb := '{}';
  new_diff jsonb := '{}';
  k text;
begin
  foreach k in array tracked loop
    if o -> k is distinct from n -> k then
      old_diff := old_diff || jsonb_build_object(k, o -> k);
      new_diff := new_diff || jsonb_build_object(k, n -> k);
    end if;
  end loop;
  if new_diff <> '{}' then
    insert into public.realtor_history (license_number, old_values, new_values)
    values (new.license_number, old_diff, new_diff);
  end if;
  return new;
end $$;

-- Ingestion job: stamp realtors that were present in today's DRE file.
-- Called in batches with the secret key; not exposed to anon/authenticated.
create or replace function public.mark_realtors_seen(p_license_numbers text[], p_seen_at timestamptz)
returns integer language sql security definer set search_path = '' as $$
  with updated as (
    update public.realtors
       set last_seen_in_dre_file_at = p_seen_at
     where license_number = any (p_license_numbers)
    returning 1
  )
  select count(*)::int from updated;
$$;

revoke execute on function public.mark_realtors_seen(text[], timestamptz) from public, anon, authenticated;
