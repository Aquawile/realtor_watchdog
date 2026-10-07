// Processed layer: parse stored raw DRE pages into dre_licensee_records,
// dre_affiliations and dre_actions. Reads only from the raw layer (dre-raw
// bucket + raw_dre_page_fetches); never contacts DRE.
//
// For each license, the latest verified 'ok' raw fetch is used. Licenses
// already processed from that same raw file with the current parser version
// are skipped, so reruns are cheap; --reprocess forces everything.
// Rows for a licensee are replaced atomically (dre_apply_parsed).
//
// Usage: node --env-file=.env.local scripts/process-dre-pages.mts [--reprocess] [--limit N]
// Exit code: 0 completed, 1 failed.

import { createClient } from "@supabase/supabase-js";
import { appendFileSync } from "node:fs";
import { PARSER_VERSION, parsePage, suspiciousName } from "./lib/dre-page-parser.mts";
import { loadRawPages, RAW_RECEIPT_COLUMNS, type RawReceipt } from "./lib/raw-pages.mts";

const APPLY_BATCH = 100;
const DOWNLOAD_CONCURRENCY = 6; // bundles (or groups of single files) in parallel
const MAX_FAILURE_RATE = 0.01;

const reprocess = process.argv.includes("--reprocess");
const limitIdx = process.argv.indexOf("--limit");
const limit = limitIdx > 0 ? Number(process.argv[limitIdx + 1]) : Infinity;

const db = createClient(process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false } });
const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function retry<T>(what: string, fn: () => PromiseLike<{ data: T; error: unknown }>, tries = 3): Promise<T> {
  for (let i = 1; ; i++) {
    const { data, error } = await fn();
    if (!error) return data;
    if (i >= tries) throw new Error(`${what}: ${JSON.stringify(error)}`);
    await sleep(2000 * i);
  }
}

const runner = process.env.GITHUB_RUN_ID ? `github-actions run ${process.env.GITHUB_RUN_ID}` : "local";
const run = await retry("create run", () => db.from("dre_process_runs").insert({ runner, parser_version: PARSER_VERSION }).select("id").single());
const runId = (run as { id: number }).id;
const stats = { considered: 0, processed: 0, skipped: 0, failed: 0, withUnparsed: 0, affiliations: 0, actions: 0, suspiciousNames: 0 };
const suspicious: string[] = [];
const failures: string[] = [];
let status: "completed" | "failed" = "completed";
let errorText: string | null = null;

try {
  // Latest verified ok raw fetch per license (single file or bundle entry).
  const latest = new Map<string, RawReceipt>();
  for (let from = 0; ; from += 1000) {
    const page = await retry("load raw receipts", () => db.from("raw_dre_page_fetches").select(RAW_RECEIPT_COLUMNS)
      .eq("outcome", "ok").not("verified_at", "is", null).order("id").range(from, from + 999));
    for (const r of page as RawReceipt[]) latest.set(r.license_number, r);
    if ((page as unknown[]).length < 1000) break;
  }
  // Already processed from the same raw file with this parser version.
  const current = new Map<string, string>();
  if (!reprocess) {
    for (let from = 0; ; from += 1000) {
      const page = await retry("load processed", () => db.from("dre_licensee_records").select("license_number,source_fetch_id,parser_version")
        .order("license_number").range(from, from + 999));
      for (const r of page as { license_number: string; source_fetch_id: number; parser_version: number }[]) {
        current.set(r.license_number, `${r.source_fetch_id}/${r.parser_version}`);
      }
      if ((page as unknown[]).length < 1000) break;
    }
  }
  const todo = [...latest.values()].filter((r) => current.get(r.license_number) !== `${r.id}/${PARSER_VERSION}`).slice(0, limit);
  stats.considered = latest.size;
  stats.skipped = latest.size - todo.length;
  log(`raw licenses: ${latest.size}; already up to date: ${stats.skipped}; to process: ${todo.length} (parser v${PARSER_VERSION})`);
  await retry("update run", () => db.from("dre_process_runs").update({ pages_considered: latest.size, pages_skipped: stats.skipped }).eq("id", runId));

  // Read raw pages (each bundle downloaded once), parse, apply in groups.
  let pending: unknown[] = [];
  const flush = async () => {
    if (!pending.length) return;
    const group = pending; pending = [];
    await retry("apply parsed", () => db.rpc("dre_apply_parsed", { p: group }));
  };
  let lastLog = Date.now();
  const recordFailure = (license: string, e: unknown) => {
    stats.failed++;
    failures.push(`${license}: ${e instanceof Error ? e.message : String(e)}`);
    if (stats.failed > 20 && stats.failed / (stats.processed + stats.failed) > MAX_FAILURE_RATE) {
      throw new Error(`too many failures (${stats.failed}); last: ${failures.at(-1)}`);
    }
  };
  await loadRawPages(db, todo, async (raw, pageBytes) => {
    const license = raw.license_number;
    try {
      const parsed = parsePage(pageBytes, license);
      pending.push({ record: { ...parsed.record, source_fetch_id: raw.id, parser_version: PARSER_VERSION },
        affiliations: parsed.affiliations, actions: parsed.actions });
      stats.processed++;
      if (parsed.record.unparsed_lines.length) stats.withUnparsed++;
      stats.affiliations += parsed.affiliations.length;
      stats.actions += parsed.actions.length;
      for (const a of parsed.affiliations) {
        if (suspiciousName(a.related_name)) { stats.suspiciousNames++; if (suspicious.length < 20) suspicious.push(`${license} [${a.kind}] ${a.related_name}`); }
      }
      if (pending.length >= APPLY_BATCH) await flush();
    } catch (e) {
      recordFailure(license, e);
    }
    if (Date.now() - lastLog > 30_000) {
      lastLog = Date.now();
      log(`${stats.processed + stats.failed}/${todo.length} (processed ${stats.processed}, failed ${stats.failed})`);
      await db.from("dre_process_runs").update({ pages_processed: stats.processed, pages_failed: stats.failed }).eq("id", runId);
    }
  }, { concurrency: DOWNLOAD_CONCURRENCY, onError: (r, e) => recordFailure(r.license_number, e) });
  await flush();
  if (stats.failed) { status = "failed"; errorText = `${stats.failed} pages failed: ${failures.slice(0, 5).join("; ")}`; }
} catch (e) {
  status = "failed";
  errorText = e instanceof Error ? e.message : String(e);
  console.error(e);
} finally {
  await db.from("dre_process_runs").update({
    status, error: errorText, finished_at: new Date().toISOString(),
    pages_processed: stats.processed, pages_failed: stats.failed, pages_with_unparsed: stats.withUnparsed,
    affiliation_rows: stats.affiliations, action_rows: stats.actions,
  }).eq("id", runId);
}

const summary = [
  `### DRE processing run ${runId}: ${status.toUpperCase()} (parser v${PARSER_VERSION})`,
  errorText ? `**Error:** ${errorText}` : "",
  `| raw licenses | processed | already up to date | failed | with unplaced lines | suspicious names | affiliation rows | action rows |`,
  `|---|---|---|---|---|---|---|---|`,
  `| ${stats.considered} | ${stats.processed} | ${stats.skipped} | ${stats.failed} | ${stats.withUnparsed} | ${stats.suspiciousNames} | ${stats.affiliations} | ${stats.actions} |`,
  suspicious.length ? `Suspicious names (status/date/address wording inside a name):\n${suspicious.map((x) => `- ${x}`).join("\n")}` : "",
].filter(Boolean).join("\n");
console.log("\n" + summary);
if (failures.length) console.log("failures:\n  " + failures.slice(0, 20).join("\n  "));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
process.exit(status === "completed" ? 0 : 1);
