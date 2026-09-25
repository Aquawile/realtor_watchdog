# Realtor Watchdog — Project Context for Claude

Read this file and the PRD docs in `docs/prd/` before doing any work. They are the source of truth.

## Working rules (from the project owner)
- ALWAYS use `docs/prd/` and this file as context for how the app works.
- NEVER make assumptions about how something should be built. If anything is unclear, ASK before building.
- You have permission to use git and to create/edit GitHub Actions workflows (e.g., for cron/scheduled jobs).
- Prefer free tiers everywhere. Do NOT use Google Cloud (GCP) for this project — the owner's GCP credits belong to a different project.
- Nothing should depend on the owner's own computer running. Hosting is managed services only (no VM, no Docker server).

## What the app is
A place where people can look up a realtor they're considering and see what other people have actually said about their experiences with that realtor — plus a fully separate property & area research tool built on public records. The two features are intentionally NOT merged.

### Feature 1: Realtor reviews (the social layer)
- Realtor profiles are system-generated from the CA DRE licensee data. Realtors do NOT have accounts and cannot create, edit, or respond to their profiles or reviews. The point is customer reviews without realtor bias.
- An account is required to POST (review/comment), not to browse or search.
- Account required ≠ transaction verification required. No mandatory proof to post.
- Reviewer MUST pick Buyer or Seller via a single tag/flair, once per review (like a Reddit post flair). Comments in that review's thread do NOT repeat the tag.
- Buyer and Seller reviews are NOT mutually exclusive; both always display together on a realtor's profile.
- Supporting documents (e.g., closing disclosure) are OPTIONAL and never block posting. Uploading one does NOT auto-grant "Verified Client"; only a moderator's manual confirmation does.
- Reviews are presented as the reviewer's own statements, never as facts asserted by the platform.
- Positive and negative reviews are treated equally. Never suppress a review for being negative.
- Report/moderation flow for false, defamatory, threatening, private, or prohibited content. Reported content stays live pending review. Dismissal is the expected outcome for reports filed only because a review is negative.
- Discussion/comments exist ONLY under realtor reviews.

### Feature 2: Property & area research (information only)
- Scope: Orange County, CA for MVP.
- Search by address → public records, each linked to its original public source.
- NO interpretation, rating, score, or "good/bad" judgment.
- NO discussion, comments, or forum anywhere in this flow. Not linked to realtor reviews.
- Goal: surface legally public information a realtor has no obligation to volunteer ("dirt"), presented as raw sourced facts.

## Legal posture
The platform makes no editorial statements about any realtor or property. It surfaces objective, publicly available, legally sourced data; users discuss among themselves. Don't add features that make the platform itself assert judgments.

## Decisions made after the PRD docs were written (these override the docs where they differ)
- **MLS is CUT from the MVP.** MLS/CRMLS data needs broker sponsorship or paid vendors. Wherever the PRD docs mention MLS:
  - Realtor identity + brokerage comes from the CA DRE licensee bulk data files alone.
  - Property sale/transfer history comes from county Assessor/Recorder public data instead of MLS.
- **Realtor data:** fully ingested (Orange County subset of DRE data) on a schedule via GitHub Actions cron.
- **Property data:** NOT bulk-ingested (OC has ~1M parcels). Use cache-aside:
  1. On search, check our DB first; serve if present and not stale.
  2. If missing or stale, fetch live from the public source, store it, serve it.
  3. TTL roughly 6–12 months (assessor/hazard data changes slowly). No background refresh jobs; refresh only when a user search triggers it.
- **We link to official source pages; we do NOT download, host, or redistribute underlying deed/record documents.**
- **Property data tiers:**
  - Tier 1 (MVP): Assessor/Recorder ownership, transfer & reassessment history; FEMA flood zone; CAL FIRE fire hazard severity zone; CA Geological Survey earthquake fault / seismic hazard zones; nearby EPA-listed hazardous sites (EPA Envirofacts).
  - Tier 2 (later): building permit history and code violations. Each OC city has its own portal; needs per-city integration.
  - Tier 3 (careful/later): police open-data crime incidents shown ONLY as a dated, sourced list. Never a "safety score."
- **Monetization:** undecided and not needed for MVP. Do NOT build realtor-facing paid features (leads, featured placement, profile boosts); they would undermine the no-realtor-bias promise.

## Decisions made in Phase 1 (owner-confirmed, 2026-09-24)
- **Reviews are discussion threads, Reddit-like (but not a Reddit copy).** A review is a post; people discuss under it and are free to be gossipy.
  - Nested replies (reply to any comment, any depth).
  - Likes and dislikes on reviews and comments. Default order is newest-first; reactions never hide content.
  - A user may post any number of reviews about the same realtor. Authors can edit (shown as "edited") and delete (shown as "[deleted]" so replies stay in place).
- **Star rating:** each review has a required 1–5 star rating. The realtor profile shows the average plus a review count, counting only visible reviews.
- **Public identity:** a unique username chosen at signup (3–20 chars, letters/digits/underscore, case-insensitive). Email is never shown.
- **Auto-hide:** reported content stays live, except when **5 distinct users** report it as Threatening or Private information. It is then hidden pending moderator review, and dismissing the report restores it.
- **DRE data (verified):** `https://secure.dre.ca.gov/datafile/CurrList.zip` → `CurrList.csv`, updated daily, ~429k rows statewide, ~53.7k unique licenses where `county_name = ORANGE`.
  - The file lists only current licensees (`Licensed` / `Licensed NBA`). A realtor who drops out is kept, with `in_current_dre_file = false`.
  - Profiles are for individuals only (Salesperson, Broker). Corporation/Officer rows are not profiles. Brokerage comes from `related_lic_*`.
  - DRE addresses are often home addresses, so only city/county are stored.
- **Schema lives in `supabase/migrations/`.** Behavioral tests: `npm run test:db` (PGlite, no Docker).

## Stack (agreed)
- Next.js (App Router) + TypeScript + Tailwind, ESLint, `src/` dir, `@/*` alias — already scaffolded.
- Supabase free tier: Postgres, Auth, Storage (optional review documents; visible to moderators only).
- Vercel free tier: hosting.
- GitHub Actions: scheduled DRE ingestion (cron). No Cloud Scheduler/Cloud Run.
- Search: Postgres full-text search (no separate search service for MVP).

## Performance targets (MVP)
- Search and property lookups: 5 seconds max.
- Responsive on mobile and desktop.

## Data sources to verify before building ingestion
- CA DRE licensee data files: https://www.dre.ca.gov/licensees/ (check exact file format and terms of use).
- Orange County Open GIS Data Portal: https://data-ocpw.opendata.arcgis.com/ (find the exact parcel/assessor layers and confirm terms).

## Current status (Phase 0)
Done:
- Next.js scaffold with dependencies installed.
- PRD docs in `docs/prd/`.
- git initialized locally.

Not done yet (owner must do these, Claude cannot create accounts):
- Create a GitHub account/repo and connect it as `origin`.
- Create a Supabase project (free tier) and supply its URL + keys via `.env.local` (never commit secrets).
- Vercel account/project (later).

Phase 1 (schema) — written and tested locally; see "Decisions made in Phase 1". Applying it to the hosted Supabase project needs the owner to link the CLI (`npx supabase login`, `npx supabase link`) and then `npx supabase db push`.

Original Phase 1 brief: Phase 1 — Postgres schema derived strictly from `docs/prd/` (REQ-001–REQ-010, UC-001–UC-031), adjusted for the MLS cut above. Ask the owner about anything the docs don't settle.
