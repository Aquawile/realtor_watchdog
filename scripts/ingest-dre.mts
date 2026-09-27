// DRE licensee ingestion (Phase 4a). Runs nightly in GitHub Actions.
//
// Downloads DRE CurrList.zip, keeps Orange County individuals (Salesperson /
// Broker), upserts them into `realtors`, flags realtors that are no longer in
// scope (dropped out of the DRE file, or moved out of OC) with
// in_current_dre_file = false, and logs the run to `dre_ingest_runs`.
//
// Usage:
//   node --env-file=.env.local scripts/ingest-dre.mts --dry-run   # read-only, prints counts
//   node --env-file=.env.local scripts/ingest-dre.mts             # writes
//
// Env: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL), SUPABASE_SECRET_KEY.

import { createClient } from "@supabase/supabase-js";
import { parse } from "csv-parse/sync";
import { unzipSync } from "fflate";

const SOURCE_URL = "https://secure.dre.ca.gov/datafile/CurrList.zip";
const SCOPE_COUNTY = "ORANGE";
const PAGE_SIZE = 1000;
const UPSERT_BATCH = 1000;
const FLAG_BATCH = 200;
const SEEN_BATCH = 5000;
// Refuse to write if today's in-scope count falls below this share of the
// realtors currently marked in-file: a truncated or changed file must not
// flag everyone as gone.
const MIN_SCOPE_RATIO = 0.9;

const EXPECTED_COLUMNS = [
  "multiple_license_ind", "lastname_primary", "firstname_secondary", "name_suffix",
  "lic_number", "lic_type", "lic_status", "lic_effective_date", "lic_expiration_date",
  "original_date_of_license", "related_lic_number", "related_lastname_primary",
  "related_firstname_secondary", "related_name_suffix", "related_lic_type",
  "address_1", "address_2", "city", "state", "zip_code", "foreign_nation",
  "foreign_postal_info", "county_name", "restricted_flag", "ethics_and_agency_ind",
];

type DreRow = Record<(typeof EXPECTED_COLUMNS)[number], string>;

type Officership = { license_number: string; name: string };

type RealtorRow = {
  license_number: string;
  last_name: string;
  first_name: string | null;
  name_suffix: string | null;
  license_type: "salesperson" | "broker";
  license_status: string;
  license_effective_date: string | null;
  license_expiration_date: string | null;
  original_license_date: string | null;
  restricted_license: boolean;
  employing_broker_license_number: string | null;
  employing_broker_name: string | null;
  officer_of: Officership[];
  city: string | null;
  county: string | null;
  in_current_dre_file: boolean;
};

// Fields compared to decide whether a stored realtor needs an update.
const COMPARED_FIELDS = [
  "last_name", "first_name", "name_suffix", "license_type", "license_status",
  "license_effective_date", "license_expiration_date", "original_license_date",
  "restricted_license", "employing_broker_license_number", "employing_broker_name",
  "officer_of", "city", "county", "in_current_dre_file",
] as const satisfies readonly (keyof RealtorRow)[];

const blank = (s: string | undefined) => (s && s.trim() !== "" ? s.trim() : null);

// DRE dates are YYYYMMDD.
function toDate(s: string): string | null {
  const v = blank(s);
  if (!v) return null;
  if (!/^\d{8}$/.test(v)) throw new Error(`unexpected DRE date: ${v}`);
  return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
}

// Individuals are "first last suffix". Corporation names that don't fit the
// first column continue in the second, split on a word boundary.
function relatedName(r: DreRow): string | null {
  const last = blank(r.related_lastname_primary);
  const first = blank(r.related_firstname_secondary);
  if (!last) return null;
  if (r.related_lic_type === "Corporation") return [last, first].filter(Boolean).join(" ");
  return [first, last, blank(r.related_name_suffix)].filter(Boolean).join(" ");
}

async function download(): Promise<DreRow[]> {
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
  const csvName = Object.keys(files).find((n) => n.toLowerCase().endsWith(".csv"));
  if (!csvName) throw new Error(`no CSV in zip (found: ${Object.keys(files).join(", ")})`);
  // The file is Latin-1, not UTF-8 (e.g. "Magaña").
  const text = new TextDecoder("latin1").decode(files[csvName]);
  const header = text.slice(0, text.indexOf("\n")).trim().split(",");
  if (header.join() !== EXPECTED_COLUMNS.join()) {
    throw new Error(`DRE file columns changed:\n  got      ${header.join()}\n  expected ${EXPECTED_COLUMNS.join()}`);
  }
  return parse(text, { columns: true, skip_empty_lines: true }) as DreRow[];
}

function buildScope(rows: DreRow[]): Map<string, RealtorRow> {
  const officerOf = new Map<string, Officership[]>();
  for (const r of rows) {
    if (r.lic_type !== "Officer" || !blank(r.related_lic_number)) continue;
    const list = officerOf.get(r.lic_number) ?? [];
    list.push({ license_number: r.related_lic_number.trim(), name: relatedName(r) ?? "" });
    officerOf.set(r.lic_number, list);
  }

  const scope = new Map<string, RealtorRow>();
  for (const r of rows) {
    if (r.lic_type !== "Salesperson" && r.lic_type !== "Broker") continue;
    if (r.county_name.trim().toUpperCase() !== SCOPE_COUNTY) continue;
    if (scope.has(r.lic_number)) throw new Error(`duplicate individual license ${r.lic_number}`);
    const officerships = (officerOf.get(r.lic_number) ?? [])
      .sort((a, b) => a.license_number.localeCompare(b.license_number));
    scope.set(r.lic_number, {
      license_number: r.lic_number.trim(),
      last_name: r.lastname_primary.trim(),
      first_name: blank(r.firstname_secondary),
      name_suffix: blank(r.name_suffix),
      license_type: r.lic_type === "Broker" ? "broker" : "salesperson",
      license_status: r.lic_status.trim(),
      license_effective_date: toDate(r.lic_effective_date),
      license_expiration_date: toDate(r.lic_expiration_date),
      original_license_date: toDate(r.original_date_of_license),
      restricted_license: r.restricted_flag.trim() === "Y",
      employing_broker_license_number: blank(r.related_lic_number),
      employing_broker_name: relatedName(r),
      officer_of: officerships,
      city: blank(r.city),
      county: blank(r.county_name),
      in_current_dre_file: true,
    });
  }
  return scope;
}

// Canonical form for comparing a DB row with a freshly built one. jsonb
// comes back with its keys reordered, so officer_of is compared as tuples.
const canon = (row: Partial<RealtorRow>) =>
  JSON.stringify(COMPARED_FIELDS.map((f) =>
    f === "officer_of"
      ? (row.officer_of ?? []).map((o) => [o.license_number, o.name])
      : row[f] ?? null));

function chunks<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY must be set");
  const db = createClient(url, key, { auth: { persistSession: false } });

  const startedAt = new Date().toISOString();
  let runId: number | null = null;
  if (!dryRun) {
    const { data, error } = await db.from("dre_ingest_runs")
      .insert({ source_url: SOURCE_URL, started_at: startedAt }).select("id").single();
    if (error) throw error;
    runId = data.id;
  }

  try {
    console.log(`Downloading ${SOURCE_URL} ...`);
    const rows = await download();
    const scope = buildScope(rows);

    console.log("Loading existing realtors ...");
    const existing = new Map<string, Partial<RealtorRow>>();
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await db.from("realtors")
        .select(COMPARED_FIELDS.join(",") + ",license_number")
        .order("license_number").range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      for (const r of data as unknown as Partial<RealtorRow>[]) existing.set(r.license_number!, r);
      if (data.length < PAGE_SIZE) break;
    }

    const toInsert: RealtorRow[] = [];
    const toUpdate: RealtorRow[] = [];
    let unchanged = 0;
    for (const row of scope.values()) {
      const cur = existing.get(row.license_number);
      if (!cur) toInsert.push(row);
      else if (canon(cur) !== canon(row)) toUpdate.push(row);
      else unchanged++;
    }
    const toFlag = [...existing.values()]
      .filter((r) => r.in_current_dre_file && !scope.has(r.license_number!))
      .map((r) => r.license_number!);
    const returning = toUpdate.filter((r) => existing.get(r.license_number)?.in_current_dre_file === false).length;
    const currentlyInFile = [...existing.values()].filter((r) => r.in_current_dre_file).length;

    const counts = {
      rows_in_file: rows.length,
      rows_in_scope: scope.size,
      inserted: toInsert.length,
      updated: toUpdate.length,
      marked_not_in_file: toFlag.length,
    };
    console.log(JSON.stringify({ ...counts, unchanged, of_updated_returning_to_file: returning,
      existing_in_db: existing.size, existing_marked_in_file: currentlyInFile }, null, 2));

    if (currentlyInFile > 1000 && scope.size < currentlyInFile * MIN_SCOPE_RATIO) {
      throw new Error(`in-scope count ${scope.size} is below ${MIN_SCOPE_RATIO * 100}% of ` +
        `${currentlyInFile} realtors currently in file; refusing to write`);
    }

    if (dryRun) {
      console.log("Dry run: nothing written.");
      return;
    }

    for (const batch of chunks([...toInsert, ...toUpdate], UPSERT_BATCH)) {
      const { error } = await db.from("realtors")
        .upsert(batch.map((r) => ({ ...r, last_seen_in_dre_file_at: startedAt })), { onConflict: "license_number" });
      if (error) throw error;
    }
    for (const batch of chunks(toFlag, FLAG_BATCH)) {
      const { error } = await db.from("realtors").update({ in_current_dre_file: false }).in("license_number", batch);
      if (error) throw error;
    }
    for (const batch of chunks([...scope.keys()], SEEN_BATCH)) {
      const { error } = await db.rpc("mark_realtors_seen", { p_license_numbers: batch, p_seen_at: startedAt });
      if (error) throw error;
    }

    const { error } = await db.from("dre_ingest_runs")
      .update({ ...counts, status: "succeeded", finished_at: new Date().toISOString() }).eq("id", runId!);
    if (error) throw error;
    console.log(`Run ${runId} succeeded.`);
  } catch (err) {
    if (runId !== null) {
      await db.from("dre_ingest_runs").update({
        status: "failed", finished_at: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
      }).eq("id", runId);
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
