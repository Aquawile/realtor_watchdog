# Realtor Watchdog — Project Context for Claude

Read this file and the PRD docs in `docs/prd/` before doing any work. They are the source of truth.

## Working rules (from the project owner)
- ALWAYS use `docs/prd/` and this file as context for how the app works.
- NEVER make assumptions about how something should be built. If anything is unclear, ASK before building.
- You have permission to use git and to create/edit GitHub Actions workflows (e.g., for cron/scheduled jobs).
- **Raw first, always.** Every external data source is stored raw and unmodified (exact bytes) before any processing, and processed data lives separately. Data is relational.
- **First full run of a new source: raw, then stop.** For the very first full run of a source (e.g. all ~49k DRE licensee pages), finish and verify the raw layer, then get the owner's explicit permission before building or running the processed layer. Once approved, later refresh runs may process automatically.
- **All work happens on the `dev` branch.** `dev` reaches `main` only through a pull request, and GitHub enforces it with ruleset "main: merge only through PRs that pass all checks" (id 24196541, no bypass for anyone):
  - PR required, no direct pushes, no force-pushes, no deleting `main`.
  - The `checks` job (`.github/workflows/checks.yml`: lint, type-check, all tests with the no-skip gate, build) must pass on an up-to-date branch.
  - Claude may open and merge `dev` → `main` PRs once every check has passed (owner-approved 2026-09-29). A failed, skipped or cancelled check means no merge. Manual-only data workflows (DRE raw fetch, DRE ingestion) are not PR checks and aren't required.
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
- **Brokerage for brokers (decided 2026-09-27):** a broker's own DRE row never names a brokerage. Profiles show the corporations they're an officer of (DRE Officer rows → `realtors.officer_of`, possibly several). Independent brokers show none. The Broker Associate List file is not used.
- **Realtors who leave scope (decided 2026-09-27):** "freeze and flag". If a realtor isn't in today's OC in-scope set, either because they left the DRE file or moved to another county, they get `in_current_dre_file = false` and are no longer updated. The profile and reviews stay. If they come back into scope they're updated and flagged true again.
- **DRE bulk ingestion (approved 2026-10-07):** `scripts/ingest-dre.mts` via `.github/workflows/dre-ingest.yml`, **twice monthly** (1st and 15th, 11:00 UTC); manual runs default to dry run. It stores the raw bulk file first (`raw_dre_bulk_files`). The fingerprint check reads back only `license_number`, `dre_fingerprint` and `in_current_dre_file` (about 3.5 MB), and writes only new or changed realtors. It refuses to write if the in-scope count drops below 90% of realtors currently in file. Pure logic and tests: `scripts/lib/realtors-from-bulk.mts`.
- **DRE licensee pages (decided 2026-09-27/28):** each realtor's page on DRE's Public License Lookup (`https://www2.dre.ca.gov/PublicASP/pplinfo.asp?License_id=<8 digits>`, no API) has their history: past brokerages with dates, officer roles, former names, DBAs, discipline comments, and hearing-document links. We fetch all OC pages and **extract the exact information into fields** (processed layer, after owner approval), keeping DRE's verbatim text alongside, plus a link to the live record. Hearing PDFs are linked, not downloaded.
  - **Raw layer:** `scripts/fetch-dre-pages.mts` via `.github/workflows/dre-raw-fetch.yml` (manual: `selftest`, then batches 100 → 500 → 2,000 → 10,000 → rest, stopping for owner review after each). Exact bytes go to the private Storage bucket `dre-raw`; receipts go to `raw_dre_bulk_files`, `raw_dre_fetch_batches` and `raw_dre_page_fetches`, which are server-only. Every stored file is verified by downloading it back and checking the checksum.
  - **Pacing guardrail (hard millisecond limits, 2026-09-29):** each window of 10 DRE responses is judged by its median time. Above `DRE_SOFT_LIMIT_MS` (2,500) it halves parallel requests; above `DRE_HARD_LIMIT_MS` (4,000) it drops to 1 and pauses `DRE_VERY_SLOW_PAUSE_MS` (60 s). **Hard stop:** if the first window measured after backing off is still slow (`DRE_SLOW_STREAK_STOP` = 2), the fetcher terminates itself. Only requests launched after a back-off are measured. Per-request timeout is `DRE_REQUEST_TIMEOUT_MS` (15,000). It also stops on HTTP 403/429/503, 5 errors in a row, or >2% errors. Ratio rules were removed after batch 7, where a 5.6 s slow start inflated the baseline. Normal DRE: ~1.1–1.5 s, p90 ~1.9 s. No robots.txt on www2, no published rate limit.
  - **Test batches build toward the full run (decided 2026-09-29):** each batch fetches the NEXT licenses not yet stored (sorted license order), so nothing is fetched twice and test data is kept, not deleted. Each run's summary shows its license range.
  - **Always parallel:** fetching is parallel under the guardrail. Verification happens inline and in parallel: each file is read back and checksummed right after upload. Pacing settings are environment variables `DRE_*`, set as GitHub repository variables (Settings → Secrets and variables → Actions → Variables). DRE's live response-time ratio is written to `raw_dre_fetch_batches.window_ratio`.
  - **Monitoring:** `node --env-file=.env.local scripts/watch-dre-batch.mts --run <github run id>` watches the GitHub run and the batch record together. It alerts on a silent heartbeat, DRE slowing down, errors, or a runner that died.
  - Batch 4 (first real batch, 200 pages, 2026-09-28): 200/200 ok and verified, DRE steady at ~1.09 s up to 8 parallel. Verification was the bottleneck at 0.86 s/file sequential, which is why it's now inline and parallel.
  - Processed-layer design so far: one-per-realtor facts become columns on `realtors`; repeating facts go into 2 tables (`realtor_affiliations`, `realtor_dre_actions`). Column names are finalized only after a field survey of all raw pages, reviewed by the owner.
- **DRE raw layer: first full run (2026-09-28 → 10-05).** 44,354 of ~49,340 OC pages stored and verified, with 0 errors in any batch and 2 guardrail hard stops (batches 16 and 19). The owner chose to leave the final ~5,000 for later and approved the processed layer on 2026-10-05.
- **DRE processed layer (approved 2026-10-05):** `scripts/process-dre-pages.mts` (parser: `scripts/lib/dre-page-parser.mts`, designed from a field survey of all 44,354 pages via `scripts/survey-dre-raw.mts`) writes three server-only tables keyed by license number. They join to `realtors` once the bulk file is loaded.
  - `dre_licensee_records`: one row per licensee: status verbatim, restricted/NBA flags, dates, NMLS IDs, former names, and `unparsed_lines` (anything not placed, kept verbatim).
  - `dre_affiliations`: brokers current and past with dates, broker-associate roles, officer roles (expired/canceled), branch-manager roles, supervised salespersons and broker associates, DBAs.
  - `dre_actions`: discipline comments verbatim with dates, plus DRE hearing-document links (linked, never hosted).
  - Officer roles record DRE's end wording as stated: `expired`, `canceled`, `revoked`, `surrendered` or `suspended` (55 revoked roles were misread as current in parser v1). DRE's "There are currently N Salespersons…" for large brokers is stored as `salespersons_count_reported`.
  - **Quality rule:** status or note wording is never absorbed into a name; anything unrecognized stays in `unparsed_lines`. Every processing run reports a "suspicious names" count (it should be 0) next to the unplaced-lines count.
  - State after the first run (parser v3, 2026-10-05): 44,354 records, 82,775 affiliations, 5,191 actions; 3 pages with unplaced address fragments; database 126 MB.
  - Addresses are dropped. Every row records `source_fetch_id` and `parser_version`, so the layer can be rebuilt from raw. Rows for a licensee are replaced atomically (`dre_apply_parsed`).
  - **Auto-routing:** `.github/workflows/dre-raw-fetch.yml` runs `.github/workflows/dre-process.yml` after every successful fetch batch. It can also be run by hand, with `reprocess` to rebuild everything.
- **Space budget (agreed 2026-10-08). Free limits: 500 MB database, 1 GB Storage. Budget before adding data.**
  - **Measured 2026-10-11 after cleanup: database 87 MB** (realtors 31 MB, dre_affiliations 21 MB, receipts 13 MB, dre_licensee_records 9 MB). `VACUUM FULL` has to be run through `psql` on the session pooler (port 5432), not the SQL Editor, which wraps queries in a transaction.
  - Database: Supabase system data ~15 MB, realtor data (bulk + DRE history) ~95 MB, users/reviews/comments/reports ~50 MB, **property cache capped at ~200 MB** (least-recently-viewed dropped first, rebuilt from raw), ~140 MB headroom.
  - Storage: raw DRE pages ~100 MB, raw bulk files (latest 6 kept), raw property responses ~300 MB cap, reviewer documents ~200 MB, ~250 MB headroom.
  - **Every Storage object costs ~1.2 KB of database space** (Supabase's `storage.objects` row). So raw data is stored as **bundles** (`.tar`, about 1,000 pages each; `scripts/lib/raw-pages.mts`, `scripts/lib/tar.mts`), not thousands of tiny files. Pages are byte-identical inside; receipts point to (bundle, entry) and keep checksums. Bundling deletes single files only after the bundle is re-verified.
  - Users never see raw tables or fetch bookkeeping (HTTP headers, request URLs, checksums). Fetch headers and URLs were archived to Storage (`raw_archives`) and are not kept in the database.
  - Maintenance: `scripts/maintain-dre-raw.mts` (`--bundle`, `--archive-headers`, `--show <license>` prints a raw page, `--purge-bulk`), via the `DRE raw maintenance` workflow.
  - "Last confirmed in DRE's list" = start of the latest succeeded `dre_ingest_runs` run for realtors still in the file. Rows aren't rewritten just to re-stamp a date.
- **Testing:** `npm test` runs every suite and fails on any failed, skipped, todo or missing test. `.github/workflows/checks.yml` runs lint, type-check, tests and build on every push, and data workflows run it first.
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

## Roadmap
- **Phase 0 — Scaffold.** Next.js app, PRD docs, GitHub repo, Supabase project. ✅
- **Phase 1 — Schema.** Supabase migrations + `npm run test:db`. ✅ Pushed to the hosted project with `supabase db push`.
- **Phase 2 — Auth + data layer.** Supabase Auth (signup with username, login, recovery, 30-min idle timeout), typed data-access functions.
- **Phase 3 — UI.** Realtor search/profile, review threads, property research pages (responsive).
- **Phase 4 — Data ingestion + property lookups.** 4a: nightly DRE ingestion via GitHub Actions (pulled forward, done before Phase 2). 4b: cache-aside property lookups (Tier 1 sources).
- **Phase 5 — Moderation tools.** Report queue, remove/label/dismiss, Verified Client review.
- **Phase 6 — Pre-launch.** Vercel deploy, security review, performance check (5 s targets), legal/terms pages.

## Current status
- Owner setup done: GitHub repo (`origin`), Supabase project (keys in `.env.local`, never committed). Vercel comes later.
- Phase 4a (DRE ingestion) in progress on `dev`. The raw-layer code is built and tested locally. Its migration (`20260928000000_raw_dre_pages.sql`) is NOT applied yet, and the workflows are not on `main` yet (both need owner approval).
- Local dev note: a stray `node` v20.7 package in the owner's home folder (`~/node_modules/.bin/node`) shadows Node 22 inside `npm run`, so `npm run build` fails locally. The owner chose to leave it. Run Next directly with `node node_modules/next/dist/bin/next build`, or run scripts with `node ...`.
