// DRE bulk-file ingestion into `realtors` (weekly, GitHub Actions).
//
//   1. Download CurrList.zip and store the exact bytes in the raw layer
//      (dre-raw bucket + raw_dre_bulk_files) before using them.
//   2. Build Orange County individuals (Salesperson / Broker) from those bytes.
//   3. Fingerprint check: read back only (license_number, dre_fingerprint,
//      in_current_dre_file) and write only realtors that are new, changed, or
//      back in scope.
//   4. Freeze and flag: realtors no longer in scope (left the DRE file or moved
//      out of OC) get in_current_dre_file = false and are not updated further.
//   5. Stamp last_seen_in_dre_file_at for everyone in scope.
//   Each run is logged in dre_ingest_runs.
//
// Usage:
//   node --env-file=.env.local scripts/ingest-dre.mts --dry-run   # read-only, prints counts
//   node --env-file=.env.local scripts/ingest-dre.mts             # writes
// Env: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL), SUPABASE_SECRET_KEY.

import { createClient } from "@supabase/supabase-js";
import { appendFileSync } from "node:fs";
import { BULK_SOURCE_URL, downloadBulkZip, parseBulkZip, storeBulkRaw } from "./lib/dre-bulk.mts";
import { buildScope, fingerprint } from "./lib/realtors-from-bulk.mts";

const PAGE_SIZE = 1000;
const UPSERT_BATCH = 500;
const FLAG_BATCH = 200;
const SEEN_BATCH = 5000;
// Refuse to write if today's in-scope count falls below this share of the
// realtors currently marked in-file: a truncated or changed file must not
// flag everyone as gone.
const MIN_SCOPE_RATIO = 0.9;

const chunks = <T,>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY must be set");
  const db = createClient(url, key, { auth: { persistSession: false } });
  // Reads must return data; writes (insert/update/rpc without .select) legitimately return none.
  const read = <T,>(what: string, r: { data: T | null; error: unknown }): T => {
    if (r.error) throw new Error(`${what}: ${JSON.stringify(r.error)}`);
    if (r.data === null) throw new Error(`${what}: no data returned`);
    return r.data;
  };
  const must = (what: string, r: { error: unknown }): void => {
    if (r.error) throw new Error(`${what}: ${JSON.stringify(r.error)}`);
  };

  const startedAt = new Date().toISOString();
  let runId: number | null = null;
  if (!dryRun) {
    runId = read<{ id: number }>("create run", await db.from("dre_ingest_runs").insert({ source_url: BULK_SOURCE_URL, started_at: startedAt })
      .select("id").single()).id;
  }

  try {
    console.log(`Downloading ${BULK_SOURCE_URL} ...`);
    const bulk = await downloadBulkZip();
    // Raw first: the exact bytes are stored before they're used (dry runs too).
    const bulkId = await storeBulkRaw(db, bulk);
    const rows = parseBulkZip(bulk.bytes);
    const scope = buildScope(rows);

    console.log("Loading existing fingerprints ...");
    const existing = new Map<string, { fp: string | null; inFile: boolean }>();
    for (let from = 0; ; from += PAGE_SIZE) {
      const page = read("load fingerprints", await db.from("realtors").select("license_number,dre_fingerprint,in_current_dre_file")
        .order("license_number").range(from, from + PAGE_SIZE - 1));
      for (const r of page) existing.set(r.license_number, { fp: r.dre_fingerprint, inFile: r.in_current_dre_file });
      if (page.length < PAGE_SIZE) break;
    }

    let inserted = 0, updated = 0, returning = 0, unchanged = 0;
    const toWrite: Record<string, unknown>[] = [];
    for (const row of scope.values()) {
      const fp = fingerprint(row);
      const cur = existing.get(row.license_number);
      if (cur && cur.fp === fp && cur.inFile) { unchanged++; continue; }
      if (!cur) inserted++; else { updated++; if (!cur.inFile) returning++; }
      toWrite.push({ ...row, dre_fingerprint: fp, in_current_dre_file: true, last_seen_in_dre_file_at: startedAt });
    }
    const toFlag = [...existing].filter(([lic, r]) => r.inFile && !scope.has(lic)).map(([lic]) => lic);
    const currentlyInFile = [...existing.values()].filter((r) => r.inFile).length;
    const counts = { rows_in_file: rows.length, rows_in_scope: scope.size, inserted, updated, unchanged, marked_not_in_file: toFlag.length };
    console.log(JSON.stringify({ ...counts, of_updated_returning_to_file: returning, existing_in_db: existing.size,
      existing_marked_in_file: currentlyInFile, raw_bulk_file_id: bulkId }, null, 2));

    if (currentlyInFile > 1000 && scope.size < currentlyInFile * MIN_SCOPE_RATIO) {
      throw new Error(`in-scope count ${scope.size} is below ${MIN_SCOPE_RATIO * 100}% of ${currentlyInFile} realtors currently in file; refusing to write`);
    }
    if (dryRun) { console.log("Dry run: nothing written to realtors."); return; }

    for (const batch of chunks(toWrite, UPSERT_BATCH)) {
      must("upsert realtors", await db.from("realtors").upsert(batch, { onConflict: "license_number" }));
    }
    for (const batch of chunks(toFlag, FLAG_BATCH)) {
      must("flag realtors", await db.from("realtors").update({ in_current_dre_file: false }).in("license_number", batch));
    }
    for (const batch of chunks([...scope.keys()], SEEN_BATCH)) {
      must("mark seen", await db.rpc("mark_realtors_seen", { p_license_numbers: batch, p_seen_at: startedAt }));
    }
    must("finish run", await db.from("dre_ingest_runs").update({ ...counts, bulk_file_id: bulkId, status: "succeeded",
      finished_at: new Date().toISOString() }).eq("id", runId!));

    const summary = [`### DRE bulk ingestion, run ${runId}: SUCCEEDED`,
      `| in file | OC in scope | inserted | updated | unchanged | flagged not in file |`, `|---|---|---|---|---|---|`,
      `| ${rows.length} | ${scope.size} | ${inserted} | ${updated} | ${unchanged} | ${toFlag.length} |`].join("\n");
    console.log("\n" + summary);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
  } catch (err) {
    if (runId !== null) {
      await db.from("dre_ingest_runs").update({ status: "failed", finished_at: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err) }).eq("id", runId);
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
