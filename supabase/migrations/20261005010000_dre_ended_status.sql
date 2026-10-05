-- Officer roles can end as DRE states it: expired, canceled, revoked,
-- surrendered or suspended (parser v2). Revoked roles were previously left
-- marked current.
alter table public.dre_affiliations drop constraint dre_affiliations_ended_status_check;
alter table public.dre_affiliations add constraint dre_affiliations_ended_status_check
  check (ended_status in ('expired', 'canceled', 'revoked', 'surrendered', 'suspended'));
