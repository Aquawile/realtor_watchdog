-- Realtor Watchdog — Phase 1 initial schema.
-- Source of truth: docs/prd/ + CLAUDE.md (MLS cut; property data is cache-aside).
--
-- Sections:
--   1. Extensions, enums, helpers
--   2. Users (profiles)                         REQ-001, REQ-002
--   3. Realtors (DRE ingestion)                 REQ-003, REQ-004
--   4. Reviews, comments, reactions             REQ-005, REQ-006, REQ-007
--   5. Review documents (Verified Client)       UC-015, UC-019
--   6. Reports & moderation                     REQ-010
--   7. Public read views
--   8. Property research cache (separate)       REQ-008, REQ-009
--   9. Row-level security & grants

------------------------------------------------------------------------------
-- 1. Extensions, enums, helpers
------------------------------------------------------------------------------

create extension if not exists pg_trgm with schema extensions;
create extension if not exists citext with schema extensions;

create type public.user_role as enum ('user', 'moderator');

-- DRE lic_type values for individuals. Corporation/Officer rows are not
-- realtor profiles; they only feed brokerage affiliation.
create type public.realtor_license_type as enum ('salesperson', 'broker');

-- Buyer/Seller flair, chosen once per review (never on comments).
create type public.relationship_tag as enum ('buyer', 'seller');

-- visible:               normal
-- hidden_pending_review: auto-hidden after enough threat/private-info reports
-- removed:               moderator removed it (soft delete, kept for audit)
-- deleted_by_author:     author deleted it; shown as "[deleted]" so replies stay
create type public.content_status as enum
  ('visible', 'hidden_pending_review', 'removed', 'deleted_by_author');

create type public.report_reason as enum
  ('false_statement', 'defamatory', 'threatening', 'private_information', 'spam', 'other');

create type public.report_status as enum ('open', 'dismissed', 'actioned');

create type public.moderation_action_type as enum
  ('remove', 'restore', 'label', 'unlabel', 'verify_client', 'unverify_client',
   'dismiss_report');

create type public.content_target as enum ('review', 'comment');

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

------------------------------------------------------------------------------
-- 2. Users
-- Credentials live in Supabase Auth (auth.users: bcrypt password hashing,
-- email verification, recovery tokens; storage is AES-256 encrypted at rest).
-- This table holds only public-facing profile data.
------------------------------------------------------------------------------

create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  username    extensions.citext not null unique
              check (username::text ~ '^[A-Za-z0-9_]{3,20}$'),
  role        public.user_role not null default 'user',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- Create the profile at signup from the username passed in
-- supabase.auth.signUp({ options: { data: { username } } }).
-- An invalid or taken username aborts the signup.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, username)
  values (new.id, new.raw_user_meta_data ->> 'username');
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.is_moderator()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'moderator'
  );
$$;

-- For the signup form to check before submitting.
create or replace function public.username_available(p_username text)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_username ~ '^[A-Za-z0-9_]{3,20}$'
     and not exists (
       select 1 from public.profiles
       where lower(username::text) = lower(p_username)
     );
$$;

------------------------------------------------------------------------------
-- 3. Realtors — system-generated from DRE CurrList.csv (Orange County subset).
-- Realtors have no accounts; nothing here is user-editable.
------------------------------------------------------------------------------

create table public.realtors (
  license_number                   text primary key check (license_number ~ '^[0-9]{8}$'),
  last_name                        text not null,
  first_name                       text,
  name_suffix                      text,
  full_name                        text generated always as (
                                     trim(both ' ' from
                                       coalesce(first_name, '') || ' ' || last_name ||
                                       coalesce(' ' || name_suffix, ''))
                                   ) stored,
  license_type                     public.realtor_license_type not null,
  license_status                   text not null,   -- raw DRE value, e.g. 'Licensed', 'Licensed NBA'
  license_effective_date           date,
  license_expiration_date          date,
  original_license_date            date,
  restricted_license               boolean not null default false, -- DRE restricted_flag
  -- Employing broker (DRE related_lic_* on a salesperson row). A broker may
  -- also be an officer of a brokerage corporation (Officer rows).
  employing_broker_license_number  text,
  employing_broker_name            text,
  -- Only city/county are kept: DRE addresses are often home addresses.
  city                             text,
  county                           text,
  -- Licensees who lose or don't renew their license drop out of the DRE file.
  -- The profile (and its reviews) stays; this records that fact with a date.
  in_current_dre_file              boolean not null default true,
  last_seen_in_dre_file_at         timestamptz not null default now(),
  created_at                       timestamptz not null default now(),
  updated_at                       timestamptz not null default now(),
  search_vector                    tsvector generated always as (
                                     setweight(to_tsvector('simple', coalesce(first_name, '') || ' ' || last_name), 'A') ||
                                     setweight(to_tsvector('simple', coalesce(employing_broker_name, '')), 'B') ||
                                     setweight(to_tsvector('simple', license_number), 'A')
                                   ) stored
);

create index realtors_search_idx on public.realtors using gin (search_vector);
create index realtors_full_name_trgm_idx on public.realtors
  using gin (full_name extensions.gin_trgm_ops);
create index realtors_broker_name_trgm_idx on public.realtors
  using gin (employing_broker_name extensions.gin_trgm_ops);

create trigger realtors_updated_at before update on public.realtors
  for each row execute function public.set_updated_at();

-- Audit trail of DRE-driven changes (UC-008).
create table public.realtor_history (
  id              bigint generated always as identity primary key,
  license_number  text not null references public.realtors (license_number) on delete cascade,
  changed_at      timestamptz not null default now(),
  old_values      jsonb not null,
  new_values      jsonb not null
);

create index realtor_history_license_idx on public.realtor_history (license_number, changed_at desc);

create or replace function public.log_realtor_change()
returns trigger language plpgsql as $$
declare
  tracked text[] := array[
    'last_name', 'first_name', 'name_suffix', 'license_type', 'license_status',
    'license_effective_date', 'license_expiration_date', 'restricted_license',
    'employing_broker_license_number', 'employing_broker_name', 'city', 'county',
    'in_current_dre_file'];
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

create trigger realtors_log_change after update on public.realtors
  for each row execute function public.log_realtor_change();

-- One row per GitHub Actions ingestion run.
create table public.dre_ingest_runs (
  id                  bigint generated always as identity primary key,
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  status              text not null default 'running'
                      check (status in ('running', 'succeeded', 'failed')),
  source_url          text not null,
  rows_in_file        integer,
  rows_in_scope       integer,
  inserted            integer,
  updated             integer,
  marked_not_in_file  integer,
  error               text
);

------------------------------------------------------------------------------
-- 4. Reviews, comments, reactions
------------------------------------------------------------------------------

create table public.reviews (
  id                      uuid primary key default gen_random_uuid(),
  realtor_license_number  text not null references public.realtors (license_number),
  author_id               uuid references public.profiles (id) on delete set null,
  relationship_tag        public.relationship_tag not null,
  rating                  smallint not null check (rating between 1 and 5),
  body                    text check (char_length(body) between 1 and 10000),
  status                  public.content_status not null default 'visible',
  moderator_label         text,       -- set by a moderator ("remove or label")
  is_verified_client      boolean not null default false,
  verified_by             uuid references public.profiles (id) on delete set null,
  verified_at             timestamptz,
  like_count              integer not null default 0,
  dislike_count           integer not null default 0,
  comment_count           integer not null default 0,
  created_at              timestamptz not null default now(),
  edited_at               timestamptz,
  -- Body is cleared when the author deletes; required otherwise.
  check (body is not null or status = 'deleted_by_author')
);

create index reviews_realtor_created_idx on public.reviews (realtor_license_number, created_at desc);
create index reviews_author_idx on public.reviews (author_id);

create table public.comments (
  id                 uuid primary key default gen_random_uuid(),
  review_id          uuid not null references public.reviews (id) on delete cascade,
  parent_comment_id  uuid references public.comments (id) on delete cascade,
  author_id          uuid references public.profiles (id) on delete set null,
  body               text check (char_length(body) between 1 and 5000),
  status             public.content_status not null default 'visible',
  moderator_label    text,
  like_count         integer not null default 0,
  dislike_count      integer not null default 0,
  created_at         timestamptz not null default now(),
  edited_at          timestamptz,
  check (body is not null or status = 'deleted_by_author')
  -- Deliberately no relationship_tag: comments inherit the review's (UC-021).
);

create index comments_review_created_idx on public.comments (review_id, created_at);
create index comments_parent_idx on public.comments (parent_comment_id);
create index comments_author_idx on public.comments (author_id);

-- A reply must belong to the same review as its parent.
create or replace function public.check_comment_parent()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.parent_comment_id is not null and not exists (
    select 1 from public.comments
    where id = new.parent_comment_id and review_id = new.review_id
  ) then
    raise exception 'parent comment belongs to a different review';
  end if;
  return new;
end $$;

create trigger comments_check_parent before insert on public.comments
  for each row execute function public.check_comment_parent();

-- Stamp edited_at when the author changes content.
create or replace function public.stamp_edited_at()
returns trigger language plpgsql as $$
begin
  if new.body is distinct from old.body and new.status = 'visible' then
    new.edited_at := now();
  end if;
  return new;
end $$;

create trigger reviews_stamp_edited before update on public.reviews
  for each row execute function public.stamp_edited_at();
create trigger comments_stamp_edited before update on public.comments
  for each row execute function public.stamp_edited_at();

-- Reviews: the author may also change the rating or the Buyer/Seller tag.
create or replace function public.stamp_review_edited()
returns trigger language plpgsql as $$
begin
  if (new.rating, new.relationship_tag) is distinct from (old.rating, old.relationship_tag) then
    new.edited_at := now();
  end if;
  return new;
end $$;

create trigger reviews_stamp_meta_edited before update on public.reviews
  for each row execute function public.stamp_review_edited();

create or replace function public.bump_comment_count()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    update public.reviews set comment_count = comment_count + 1 where id = new.review_id;
  elsif tg_op = 'DELETE' then
    update public.reviews set comment_count = comment_count - 1 where id = old.review_id;
  end if;
  return null;
end $$;

create trigger comments_count after insert or delete on public.comments
  for each row execute function public.bump_comment_count();

-- Likes/dislikes: one reaction per user per item; value 1 = like, -1 = dislike.
-- Feed order is newest-first by default; reactions never hide content.
create table public.review_reactions (
  review_id   uuid not null references public.reviews (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  value       smallint not null check (value in (-1, 1)),
  created_at  timestamptz not null default now(),
  primary key (review_id, user_id)
);

create table public.comment_reactions (
  comment_id  uuid not null references public.comments (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  value       smallint not null check (value in (-1, 1)),
  created_at  timestamptz not null default now(),
  primary key (comment_id, user_id)
);

create index review_reactions_user_idx on public.review_reactions (user_id);
create index comment_reactions_user_idx on public.comment_reactions (user_id);

create or replace function public.apply_reaction_counts()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  old_like int := 0; old_dislike int := 0;
  new_like int := 0; new_dislike int := 0;
  target uuid;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    old_like := (old.value = 1)::int;  old_dislike := (old.value = -1)::int;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    new_like := (new.value = 1)::int;  new_dislike := (new.value = -1)::int;
  end if;

  if tg_table_name = 'review_reactions' then
    target := coalesce(new.review_id, old.review_id);
    update public.reviews
       set like_count = like_count + new_like - old_like,
           dislike_count = dislike_count + new_dislike - old_dislike
     where id = target;
  else
    target := coalesce(new.comment_id, old.comment_id);
    update public.comments
       set like_count = like_count + new_like - old_like,
           dislike_count = dislike_count + new_dislike - old_dislike
     where id = target;
  end if;
  return null;
end $$;

create trigger review_reactions_counts after insert or update or delete on public.review_reactions
  for each row execute function public.apply_reaction_counts();
create trigger comment_reactions_counts after insert or update or delete on public.comment_reactions
  for each row execute function public.apply_reaction_counts();

-- Used by the comment insert policy (reviews RLS would otherwise hide
-- other people's reviews from the check).
create or replace function public.review_accepts_comments(p_review_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.reviews where id = p_review_id and status = 'visible');
$$;

-- Author soft-delete: keeps the row (so replies stay threaded), clears content.
create or replace function public.delete_own_review(p_review_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.reviews
     set status = 'deleted_by_author', body = null
   where id = p_review_id and author_id = auth.uid() and status = 'visible';
  if not found then
    raise exception 'review not found or not deletable';
  end if;
end $$;

create or replace function public.delete_own_comment(p_comment_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.comments
     set status = 'deleted_by_author', body = null
   where id = p_comment_id and author_id = auth.uid() and status = 'visible';
  if not found then
    raise exception 'comment not found or not deletable';
  end if;
end $$;

------------------------------------------------------------------------------
-- 5. Review documents — optional, moderator-only, never public.
-- Files live in the private Storage bucket 'review-documents' at
-- '<uploader uuid>/<review uuid>/<filename>'. Upload never grants Verified
-- Client; only a moderator setting reviews.is_verified_client does.
------------------------------------------------------------------------------

create table public.review_documents (
  id            uuid primary key default gen_random_uuid(),
  review_id     uuid not null references public.reviews (id) on delete cascade,
  uploader_id   uuid references public.profiles (id) on delete set null,
  storage_path  text not null unique,
  mime_type     text not null check (mime_type in ('application/pdf', 'image/jpeg', 'image/png')),
  size_bytes    integer not null check (size_bytes between 1 and 10485760),
  created_at    timestamptz not null default now()
);

create index review_documents_review_idx on public.review_documents (review_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('review-documents', 'review-documents', false, 10485760,
        array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do nothing;

------------------------------------------------------------------------------
-- 6. Reports & moderation
------------------------------------------------------------------------------

-- Distinct reporters of threatening/private-information needed to auto-hide.
create or replace function public.auto_hide_threshold()
returns integer language sql immutable as $$ select 5 $$;

create table public.reports (
  id               uuid primary key default gen_random_uuid(),
  target_type      public.content_target not null,
  review_id        uuid references public.reviews (id) on delete cascade,
  comment_id       uuid references public.comments (id) on delete cascade,
  reporter_id      uuid references public.profiles (id) on delete set null,
  reason           public.report_reason not null,
  notes            text check (char_length(notes) <= 2000),
  status           public.report_status not null default 'open',
  resolved_by      uuid references public.profiles (id) on delete set null,
  resolved_at      timestamptz,
  resolution_note  text,
  created_at       timestamptz not null default now(),
  check (
    (target_type = 'review'  and review_id is not null and comment_id is null) or
    (target_type = 'comment' and comment_id is not null and review_id is null)
  )
);

-- One report per user per item (so "N distinct reporters" is meaningful).
create unique index reports_one_per_reporter_review
  on public.reports (reporter_id, review_id) where review_id is not null;
create unique index reports_one_per_reporter_comment
  on public.reports (reporter_id, comment_id) where comment_id is not null;
create index reports_queue_idx on public.reports (status, created_at);

-- Content stays live when reported. Exception (REQ-010): once
-- auto_hide_threshold() distinct users report it as threatening or private
-- information, hide it pending moderator review.
create or replace function public.maybe_auto_hide()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  n int;
begin
  if new.reason not in ('threatening', 'private_information') then
    return null;
  end if;

  if new.target_type = 'review' then
    select count(distinct reporter_id) into n from public.reports
     where review_id = new.review_id and status = 'open'
       and reason in ('threatening', 'private_information');
    if n >= public.auto_hide_threshold() then
      update public.reviews set status = 'hidden_pending_review'
       where id = new.review_id and status = 'visible';
    end if;
  else
    select count(distinct reporter_id) into n from public.reports
     where comment_id = new.comment_id and status = 'open'
       and reason in ('threatening', 'private_information');
    if n >= public.auto_hide_threshold() then
      update public.comments set status = 'hidden_pending_review'
       where id = new.comment_id and status = 'visible';
    end if;
  end if;
  return null;
end $$;

create trigger reports_auto_hide after insert on public.reports
  for each row execute function public.maybe_auto_hide();

-- Every moderator action is logged (UC-030 audit trail).
create table public.moderation_actions (
  id            bigint generated always as identity primary key,
  moderator_id  uuid references public.profiles (id) on delete set null,
  action        public.moderation_action_type not null,
  review_id     uuid references public.reviews (id) on delete set null,
  comment_id    uuid references public.comments (id) on delete set null,
  reason        text,
  created_at    timestamptz not null default now()
);

create index moderation_actions_created_idx on public.moderation_actions (created_at desc);

-- Moderator RPC: act on a review or comment and close its open reports.
--   p_action: 'remove' | 'restore' | 'label' | 'unlabel' | 'dismiss_report'
create or replace function public.moderate_content(
  p_target      public.content_target,
  p_id          uuid,
  p_action      public.moderation_action_type,
  p_reason      text default null,
  p_label       text default null
) returns void language plpgsql security definer set search_path = '' as $$
declare
  report_outcome public.report_status;
begin
  if not public.is_moderator() then
    raise exception 'moderator role required';
  end if;
  if p_action not in ('remove', 'restore', 'label', 'unlabel', 'dismiss_report') then
    raise exception 'unsupported action %', p_action;
  end if;
  if p_action = 'label' and nullif(trim(p_label), '') is null then
    raise exception 'label text required';
  end if;

  if p_target = 'review' then
    update public.reviews set
      status = case p_action
                 when 'remove'  then 'removed'
                 when 'restore' then case when status in ('removed', 'hidden_pending_review')
                                          then 'visible' else status end
                 -- Dismissing restores anything auto-hidden.
                 when 'dismiss_report' then case when status = 'hidden_pending_review'
                                                 then 'visible' else status end
                 else status end,
      moderator_label = case p_action
                          when 'label' then p_label
                          when 'unlabel' then null
                          else moderator_label end
    where id = p_id;
  else
    update public.comments set
      status = case p_action
                 when 'remove'  then 'removed'
                 when 'restore' then case when status in ('removed', 'hidden_pending_review')
                                          then 'visible' else status end
                 when 'dismiss_report' then case when status = 'hidden_pending_review'
                                                 then 'visible' else status end
                 else status end,
      moderator_label = case p_action
                          when 'label' then p_label
                          when 'unlabel' then null
                          else moderator_label end
    where id = p_id;
  end if;
  if not found then
    raise exception '% % not found', p_target, p_id;
  end if;

  report_outcome := case when p_action = 'dismiss_report' then 'dismissed'
                         when p_action in ('remove', 'label') then 'actioned'
                         else null end;
  if report_outcome is not null then
    update public.reports
       set status = report_outcome, resolved_by = auth.uid(),
           resolved_at = now(), resolution_note = p_reason
     where status = 'open'
       and ((p_target = 'review' and review_id = p_id) or
            (p_target = 'comment' and comment_id = p_id));
  end if;

  insert into public.moderation_actions (moderator_id, action, review_id, comment_id, reason)
  values (auth.uid(), p_action,
          case when p_target = 'review' then p_id end,
          case when p_target = 'comment' then p_id end,
          coalesce(p_reason, p_label));
end $$;

-- Moderator RPC: grant/revoke Verified Client after checking the document.
create or replace function public.set_verified_client(
  p_review_id uuid, p_verified boolean, p_reason text default null
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_moderator() then
    raise exception 'moderator role required';
  end if;
  update public.reviews
     set is_verified_client = p_verified,
         verified_by = case when p_verified then auth.uid() end,
         verified_at = case when p_verified then now() end
   where id = p_review_id;
  if not found then
    raise exception 'review % not found', p_review_id;
  end if;
  insert into public.moderation_actions (moderator_id, action, review_id, reason)
  values (auth.uid(),
          case when p_verified then 'verify_client' else 'unverify_client' end::public.moderation_action_type,
          p_review_id, p_reason);
end $$;

------------------------------------------------------------------------------
-- 7. Public read views
-- Base tables are not directly readable by anon/authenticated for other
-- people's content; these views mask content that isn't visible while keeping
-- the row, so nested replies under it stay in place ("[deleted]"/"[removed]").
-- They run with the owner's rights on purpose.
------------------------------------------------------------------------------

create view public.review_feed as
select
  r.id,
  r.realtor_license_number,
  r.relationship_tag,
  case when r.status = 'visible' then r.rating end            as rating,
  case when r.status = 'visible' then r.body end              as body,
  case when r.status = 'visible' then p.username::text end    as author_username,
  r.status,
  r.moderator_label,
  r.is_verified_client,
  r.like_count,
  r.dislike_count,
  r.comment_count,
  r.created_at,
  r.edited_at
from public.reviews r
left join public.profiles p on p.id = r.author_id;

create view public.comment_feed as
select
  c.id,
  c.review_id,
  c.parent_comment_id,
  case when c.status = 'visible' then c.body end              as body,
  case when c.status = 'visible' then p.username::text end    as author_username,
  c.status,
  c.moderator_label,
  c.like_count,
  c.dislike_count,
  c.created_at,
  c.edited_at
from public.comments c
left join public.profiles p on p.id = c.author_id;

-- Average stars and count per realtor, counting visible reviews only.
create view public.realtor_rating_summary as
select
  realtor_license_number,
  count(*)::int                    as review_count,
  round(avg(rating)::numeric, 2)   as average_rating
from public.reviews
where status = 'visible'
group by realtor_license_number;

create view public.public_profiles as
select id, username::text as username, created_at from public.profiles;

------------------------------------------------------------------------------
-- 8. Property research cache (Feature 2). Fully separate from Feature 1:
-- no foreign keys to realtors/reviews, and no discussion tables.
-- Cache-aside: server looks up by normalized address / APN; if a source row
-- is missing or past expires_at, it fetches live from the public source and
-- upserts here. Only the server (secret key) writes.
------------------------------------------------------------------------------

create table public.properties (
  id                  uuid primary key default gen_random_uuid(),
  apn                 text unique,                 -- OC Assessor parcel number
  address_normalized  text not null unique,
  address_display     text not null,
  city                text,
  zip                 text,
  latitude            double precision,
  longitude           double precision,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index properties_address_trgm_idx on public.properties
  using gin (address_normalized extensions.gin_trgm_ops);

create trigger properties_updated_at before update on public.properties
  for each row execute function public.set_updated_at();

-- One cached payload per (property, source). The payload is stored as the
-- source returned it; the UI renders raw facts plus the source link.
-- Source keys (Tier 1): 'oc_assessor', 'fema_flood', 'calfire_fhsz',
-- 'cgs_seismic', 'epa_envirofacts'. Tier 2/3 will add keys, not tables.
create table public.property_source_data (
  property_id  uuid not null references public.properties (id) on delete cascade,
  source       text not null check (source ~ '^[a-z0-9_]+$'),
  payload      jsonb not null,
  source_url   text not null,          -- official page the UI links to
  fetched_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  primary key (property_id, source)
);

create index property_source_data_expires_idx on public.property_source_data (expires_at);

------------------------------------------------------------------------------
-- 9. Row-level security & grants
------------------------------------------------------------------------------

alter table public.profiles             enable row level security;
alter table public.realtors             enable row level security;
alter table public.realtor_history      enable row level security;
alter table public.dre_ingest_runs      enable row level security;
alter table public.reviews              enable row level security;
alter table public.comments             enable row level security;
alter table public.review_reactions     enable row level security;
alter table public.comment_reactions    enable row level security;
alter table public.review_documents     enable row level security;
alter table public.reports              enable row level security;
alter table public.moderation_actions   enable row level security;
alter table public.properties           enable row level security;
alter table public.property_source_data enable row level security;

-- Start from nothing, then grant exactly what's needed. The service role
-- (ingestion job, property cache server routes) bypasses RLS.
revoke all on all tables in schema public from anon, authenticated;

-- Public research data: readable by everyone, writable only by the server.
grant select on public.realtors, public.realtor_history,
                public.properties, public.property_source_data to anon, authenticated;
create policy "public read" on public.realtors             for select using (true);
create policy "public read" on public.realtor_history      for select using (true);
create policy "public read" on public.properties           for select using (true);
create policy "public read" on public.property_source_data for select using (true);

-- Public views (see section 7).
grant select on public.review_feed, public.comment_feed,
                public.realtor_rating_summary, public.public_profiles to anon, authenticated;

-- Profiles: users read/update their own row. Username is set at signup;
-- role can only change via the service role.
grant select on public.profiles to authenticated;
grant update (username) on public.profiles to authenticated;
create policy "own profile read" on public.profiles
  for select to authenticated using (id = auth.uid() or public.is_moderator());
create policy "own profile update" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- Reviews: posting requires an account. Authors may edit body/rating/tag
-- while visible. Delete goes through delete_own_review(). Moderators read all.
grant select, insert on public.reviews to authenticated;
grant update (body, rating, relationship_tag) on public.reviews to authenticated;
create policy "author or moderator read" on public.reviews
  for select to authenticated using (author_id = auth.uid() or public.is_moderator());
create policy "post review" on public.reviews
  for insert to authenticated with check (
    author_id = auth.uid() and status = 'visible' and is_verified_client = false
    and moderator_label is null and like_count = 0 and dislike_count = 0
    and comment_count = 0 and verified_by is null and verified_at is null
  );
create policy "edit own review" on public.reviews
  for update to authenticated
  using (author_id = auth.uid() and status = 'visible')
  with check (author_id = auth.uid() and status = 'visible');

grant select, insert on public.comments to authenticated;
grant update (body) on public.comments to authenticated;
create policy "author or moderator read" on public.comments
  for select to authenticated using (author_id = auth.uid() or public.is_moderator());
create policy "post comment" on public.comments
  for insert to authenticated with check (
    author_id = auth.uid() and status = 'visible' and moderator_label is null
    and like_count = 0 and dislike_count = 0
    and public.review_accepts_comments(review_id)
  );
create policy "edit own comment" on public.comments
  for update to authenticated
  using (author_id = auth.uid() and status = 'visible')
  with check (author_id = auth.uid() and status = 'visible');

-- Reactions: users manage their own like/dislike.
grant select, insert, delete on public.review_reactions, public.comment_reactions to authenticated;
grant update (value) on public.review_reactions, public.comment_reactions to authenticated;
create policy "own reactions" on public.review_reactions
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own reactions" on public.comment_reactions
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Review documents: the review's author may attach; only moderators read.
grant select, insert on public.review_documents to authenticated;
create policy "attach to own review" on public.review_documents
  for insert to authenticated with check (
    uploader_id = auth.uid()
    and exists (select 1 from public.reviews r where r.id = review_id and r.author_id = auth.uid())
    and storage_path like auth.uid()::text || '/' || review_id::text || '/%'
  );
create policy "moderators read" on public.review_documents
  for select to authenticated using (public.is_moderator());

create policy "upload own review documents" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'review-documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "moderators read review documents" on storage.objects
  for select to authenticated using (
    bucket_id = 'review-documents' and public.is_moderator()
  );

-- Reports: any signed-in user may report; reporters see their own; moderators
-- see all. Resolution goes through moderate_content().
grant select, insert on public.reports to authenticated;
create policy "file report" on public.reports
  for insert to authenticated with check (
    reporter_id = auth.uid() and status = 'open'
    and resolved_by is null and resolved_at is null and resolution_note is null
  );
create policy "reporter or moderator read" on public.reports
  for select to authenticated using (reporter_id = auth.uid() or public.is_moderator());

grant select on public.moderation_actions to authenticated;
create policy "moderators read" on public.moderation_actions
  for select to authenticated using (public.is_moderator());

-- RPCs.
revoke execute on function public.delete_own_review(uuid), public.delete_own_comment(uuid),
  public.moderate_content(public.content_target, uuid, public.moderation_action_type, text, text),
  public.set_verified_client(uuid, boolean, text)
  from public, anon;
grant execute on function public.delete_own_review(uuid), public.delete_own_comment(uuid),
  public.moderate_content(public.content_target, uuid, public.moderation_action_type, text, text),
  public.set_verified_client(uuid, boolean, text)
  to authenticated;
grant execute on function public.username_available(text) to anon, authenticated;
