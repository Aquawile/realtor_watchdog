// Raw layer: fetch DRE public license lookup pages and store them unmodified.
//
// Source: DRE's Public License Lookup page, one page per license:
//   https://www2.dre.ca.gov/PublicASP/pplinfo.asp?License_id=<8 digits>
// License numbers come from DRE's bulk file (CurrList.zip), Orange County
// salespersons and brokers only.
//
// Each run is one batch:
//   1. Mark batches whose heartbeat went silent as abandoned; refuse to start
//      if another batch is still running.
//   2. Self-heal: verify any stored files from earlier batches that were never
//      verified (e.g. the runner died before verification).
//   3. Store an exact copy of today's bulk file (skipped if unchanged).
//   4. Fetch up to --limit licenses not yet stored as ok/not_found, with the
//      pacing guardrail (see scripts/lib/raw-fetch-core.mts).
//      Each stored file is verified inline, in parallel: read back, gunzip,
//      checksum against what DRE sent. Mismatches become 'verify_failed' and
//      are fetched again by the next batch.
//   5. Confirm no file from this batch was left unverified.
//
// Usage:
//   node --env-file=.env.local scripts/fetch-dre-pages.mts --selftest
//   node --env-file=.env.local scripts/fetch-dre-pages.mts --limit 100 [--max-concurrency 8] [--max-minutes 300]
//
// --selftest checks the whole path without storing any licensee pages:
// Supabase tables + Storage (write, read back, delete), the DRE bulk file,
// and one DRE lookup page.
//
// Pacing settings come from environment variables (GitHub repository
// variables in CI), falling back to DEFAULTS in scripts/lib/raw-fetch-core.mts:
//   DRE_START_CONCURRENCY, DRE_MAX_CONCURRENCY, DRE_WINDOW, DRE_SLOW_RATIO,
//   DRE_VERY_SLOW_RATIO, DRE_VERY_SLOW_PAUSE_MS, DRE_VERY_SLOW_STRIKES,
//   DRE_MAX_CONSECUTIVE_ERRORS, DRE_MAX_ERROR_RATE, DRE_REQUEST_TIMEOUT_MS,
//   DRE_VERIFY_CONCURRENCY
// --max-concurrency / --max-minutes on the command line override them.
//
// Exit codes: 0 completed, 1 failed (crash / verification failures), 2 stopped by a guardrail.

import { createClient } from "@supabase/supabase-js";
import { appendFileSync } from "node:fs";
import { BULK_SOURCE_URL, downloadBulkZip, isOcIndividual, parseBulkZip } from "./lib/dre-bulk.mts";
import {
  DEFAULTS, classify, median, p90, runFetch, sha256, verifyStored, withRetry,
  type FetchResult, type PageReceipt, type StoredReceipt,
} from "./lib/raw-fetch-core.mts";

const BUCKET = "dre-raw";
const USER_AGENT = "RealtorWatchdog/0.1 (public license record archive; low-rate)";
const STALE_BATCH_MINUTES = 10;
const MIN_EXPECTED_OC_LICENSES = 40_000; // sanity check on the bulk file

function numArg(name: string, fallback?: number): number | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = Number(process.argv[i + 1]);
  if (!Number.isFinite(v) || v <= 0) throw new Error(`--${name} needs a positive number`);
  return v;
}
const SELFTEST = process.argv.includes("--selftest");
const LIMIT = numArg("limit");
if (!SELFTEST && !LIMIT) throw new Error("pass --limit <n> or --selftest");
function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) throw new Error(`environment variable ${name}=${raw} is not a positive number`);
  return v;
}
const settings = {
  ...DEFAULTS,
  startConcurrency: envNum("DRE_START_CONCURRENCY", DEFAULTS.startConcurrency),
  maxConcurrency: numArg("max-concurrency", envNum("DRE_MAX_CONCURRENCY", DEFAULTS.maxConcurrency))!,
  window: envNum("DRE_WINDOW", DEFAULTS.window),
  slowRatio: envNum("DRE_SLOW_RATIO", DEFAULTS.slowRatio),
  verySlowRatio: envNum("DRE_VERY_SLOW_RATIO", DEFAULTS.verySlowRatio),
  verySlowPauseMs: envNum("DRE_VERY_SLOW_PAUSE_MS", DEFAULTS.verySlowPauseMs),
  verySlowStrikes: envNum("DRE_VERY_SLOW_STRIKES", DEFAULTS.verySlowStrikes),
  maxConsecutiveErrors: envNum("DRE_MAX_CONSECUTIVE_ERRORS", DEFAULTS.maxConsecutiveErrors),
  maxErrorRate: envNum("DRE_MAX_ERROR_RATE", DEFAULTS.maxErrorRate),
  requestTimeoutMs: envNum("DRE_REQUEST_TIMEOUT_MS", DEFAULTS.requestTimeoutMs),
  maxMinutes: numArg("max-minutes", DEFAULTS.maxMinutes)!,
};
const VERIFY_CONCURRENCY = envNum("DRE_VERIFY_CONCURRENCY", 10);
if (settings.slowRatio >= settings.verySlowRatio) throw new Error("DRE_SLOW_RATIO must be below DRE_VERY_SLOW_RATIO");
if (settings.startConcurrency > settings.maxConcurrency) settings.startConcurrency = settings.maxConcurrency;

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY must be set");
const db = createClient(url, key, { auth: { persistSession: false } });

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);

// Supabase returns { data, error }. Reads: errors and missing data throw.
async function q<T>(what: string, p: PromiseLike<{ data: T | null; error: unknown }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`${what}: ${JSON.stringify(error)}`);
  if (data === null) throw new Error(`${what}: no data returned`);
  return data;
}
// Writes (insert/update without .select()) legitimately return no data: only errors throw.
async function w(what: string, p: PromiseLike<{ error: unknown }>): Promise<void> {
  const { error } = await p;
  if (error) throw new Error(`${what}: ${JSON.stringify(error)}`);
}

async function fetchPage(pageUrl: string, timeoutMs: number) {
  const res = await fetch(pageUrl, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, headers: Object.fromEntries(res.headers), bytes: new Uint8Array(await res.arrayBuffer()) };
}

const downloadStored = async (path: string) =>
  new Uint8Array(await (await q("download", db.storage.from(BUCKET).download(path))).arrayBuffer());

// Verify stored files in parallel and record the results (one write per 200 verified).
async function verifyAndRecord(receipts: StoredReceipt[]) {
  const { verifiedIds, failed } = await verifyStored(receipts, downloadStored, sleep, VERIFY_CONCURRENCY);
  const at = new Date().toISOString();
  for (let i = 0; i < verifiedIds.length; i += 200) {
    const ids = verifiedIds.slice(i, i + 200);
    await withRetry("mark verified", () => w("mark verified", db.from("raw_dre_page_fetches").update({ verified_at: at }).in("id", ids)), 3, sleep);
  }
  for (const f of failed) {
    await withRetry("mark verify_failed", () => w("mark verify_failed", db.from("raw_dre_page_fetches")
      .update({ outcome: "verify_failed", error: `verification: ${f.reason}` }).eq("id", f.id)), 3, sleep);
  }
  return { verified: verifiedIds.length, failed: failed.length };
}

async function unverified(batchId?: number): Promise<StoredReceipt[]> {
  const out: StoredReceipt[] = [];
  for (let from = 0; ; from += 1000) {
    let query = db.from("raw_dre_page_fetches").select("id, storage_path, sha256_raw, byte_size")
      .is("verified_at", null).not("storage_path", "is", null).neq("outcome", "verify_failed");
    if (batchId !== undefined) query = query.eq("batch_id", batchId);
    const page = await q("load unverified", query.order("id").range(from, from + 999));
    out.push(...(page as StoredReceipt[]));
    if (page.length < 1000) break;
  }
  return out;
}

async function selftest(batchId: number): Promise<string[]> {
  const checks: string[] = [];
  // Storage round trip.
  const path = `selftest/${new Date().toISOString()}.txt`;
  const body = new TextEncoder().encode(`selftest ${Date.now()}`);
  await q("storage upload", db.storage.from(BUCKET).upload(path, body, { contentType: "text/plain" }));
  const back = new Uint8Array(await (await q("storage download", db.storage.from(BUCKET).download(path))).arrayBuffer());
  if (sha256(back) !== sha256(body)) throw new Error("storage round trip returned different bytes");
  await q("storage delete", db.storage.from(BUCKET).remove([path]));
  checks.push("Supabase Storage: write, read back (checksum match), delete");
  // Tables readable with the secret key.
  await q("read receipts", db.from("raw_dre_page_fetches").select("id").limit(1));
  await q("read bulk files", db.from("raw_dre_bulk_files").select("id").limit(1));
  checks.push("Supabase tables: batch row written, receipts and bulk tables readable");
  // Every write shape a real batch uses: batch update, receipt insert, receipt update, delete.
  await w("selftest set plan", db.from("raw_dre_fetch_batches").update({ planned_count: 0 }).eq("id", batchId));
  await w("selftest progress", db.from("raw_dre_fetch_batches").update({ attempted: 0, current_concurrency: 1, last_heartbeat_at: new Date().toISOString() }).eq("id", batchId));
  await w("selftest log receipt", db.from("raw_dre_page_fetches").insert({
    batch_id: batchId, license_number: "00000000", requested_url: "selftest", duration_ms: 0, attempts: 1, outcome: "network_error", error: "selftest receipt",
  }));
  const [receipt] = await q("selftest read receipt", db.from("raw_dre_page_fetches").select("id").eq("batch_id", batchId).eq("license_number", "00000000"));
  if (!receipt) throw new Error("selftest receipt not found after insert");
  await w("selftest mark verified", db.from("raw_dre_page_fetches").update({ verified_at: new Date().toISOString() }).eq("id", receipt.id));
  await w("selftest delete receipt", db.from("raw_dre_page_fetches").delete().eq("id", receipt.id));
  checks.push("Supabase writes: batch update, receipt insert, receipt update, delete");
  // DRE bulk file.
  const bulk = await downloadBulkZip();
  const oc = parseBulkZip(bulk.bytes).filter(isOcIndividual).map((r) => r.lic_number.trim());
  if (oc.length < MIN_EXPECTED_OC_LICENSES) throw new Error(`bulk file has only ${oc.length} OC individuals`);
  checks.push(`DRE bulk file: ${bulk.bytes.length} bytes, ${oc.length} OC individuals`);
  // One DRE lookup page (not stored).
  const t = performance.now();
  const page = await fetchPage(DEFAULTS.lookupUrl + oc[0], DEFAULTS.requestTimeoutMs);
  const kind = page.status === 200 ? classify(page.bytes) : `HTTP ${page.status}`;
  if (kind !== "ok") throw new Error(`DRE lookup test page for ${oc[0]}: ${kind}`);
  checks.push(`DRE lookup page: HTTP 200, complete record, ${Math.round(performance.now() - t)} ms`);
  return checks;
}

async function main() {
  const t0 = Date.now();
  const runner = process.env.GITHUB_RUN_ID
    ? `github-actions run ${process.env.GITHUB_RUN_ID} attempt ${process.env.GITHUB_RUN_ATTEMPT} on ${process.env.RUNNER_NAME ?? "?"}`
    : "local";

  // 1. Stale / concurrent batches.
  const staleBefore = new Date(Date.now() - STALE_BATCH_MINUTES * 60_000).toISOString();
  const abandoned = await q("mark abandoned", db.from("raw_dre_fetch_batches")
    .update({ status: "abandoned", stop_reason: `heartbeat silent for > ${STALE_BATCH_MINUTES} min`, finished_at: new Date().toISOString() })
    .eq("status", "running").lt("last_heartbeat_at", staleBefore).select("id"));
  if (abandoned.length) log(`marked abandoned batches: ${abandoned.map((b) => b.id).join(", ")}`);
  const running = await q("check running", db.from("raw_dre_fetch_batches").select("id").eq("status", "running"));
  if (running.length) throw new Error(`batch ${running.map((b) => b.id).join(", ")} is still running; refusing to start`);

  const batch = await q<{ id: number }>("create batch", db.from("raw_dre_fetch_batches").insert({
    runner, current_concurrency: settings.startConcurrency,
    settings: { mode: SELFTEST ? "selftest" : "fetch", limit: LIMIT ?? null, user_agent: USER_AGENT, ...settings },
  }).select("id").single());
  const batchId = batch.id as number;
  log(`batch ${batchId} started (${runner}, ${SELFTEST ? "selftest" : `limit ${LIMIT}`})`);

  let stopSignal: string | null = null;
  process.on("SIGINT", () => { stopSignal ??= "received SIGINT (cancelled)"; log(stopSignal); });
  process.on("SIGTERM", () => { stopSignal ??= "received SIGTERM (cancelled or timed out)"; log(stopSignal); });
  const heartbeat = setInterval(() => {
    db.from("raw_dre_fetch_batches").update({ last_heartbeat_at: new Date().toISOString() }).eq("id", batchId)
      .then(({ error }) => { if (error) log(`heartbeat failed: ${JSON.stringify(error)}`); });
  }, 15_000);

  let status: FetchResult["status"] = "completed";
  let stopReason: string | null = null;
  const lines: string[] = [];
  try {
    if (SELFTEST) {
      lines.push(...(await selftest(batchId)).map((c) => `- ✅ ${c}`));
    } else {
      // 2. Self-heal earlier batches.
      const pending = await unverified();
      if (pending.length) {
        const v = await verifyAndRecord(pending);
        lines.push(`- Earlier unverified files: ${v.verified} verified, ${v.failed} failed (will be re-fetched)`);
      }

      // 3. Bulk file.
      const bulk = await downloadBulkZip();
      const bulkSha = sha256(bulk.bytes);
      const same = await q("find bulk", db.from("raw_dre_bulk_files").select("id").eq("sha256_raw", bulkSha).limit(1));
      let bulkId: number;
      if (same.length) bulkId = same[0].id;
      else {
        const path = `bulk/${new Date().toISOString()}/CurrList.zip`;
        await q("upload bulk", db.storage.from(BUCKET).upload(path, bulk.bytes, { contentType: "application/zip" }));
        bulkId = (await q<{ id: number }>("log bulk", db.from("raw_dre_bulk_files").insert({
          source_url: BULK_SOURCE_URL, http_status: bulk.status, byte_size: bulk.bytes.length, sha256_raw: bulkSha, storage_path: path,
        }).select("id").single())).id;
      }
      const licenses = [...new Set(parseBulkZip(bulk.bytes).filter(isOcIndividual).map((r) => r.lic_number.trim()))].sort();
      if (licenses.length < MIN_EXPECTED_OC_LICENSES) throw new Error(`bulk file has only ${licenses.length} OC individuals`);

      // 4. Work list and fetch.
      const done = new Set<string>();
      for (let from = 0; ; from += 1000) {
        const page = await q("load done", db.from("raw_dre_page_fetches").select("license_number")
          .in("outcome", ["ok", "not_found"]).order("id").range(from, from + 999));
        for (const r of page) done.add(r.license_number);
        if (page.length < 1000) break;
      }
      const todo = licenses.filter((l) => !done.has(l)).slice(0, LIMIT);
      const range = todo.length ? `${todo[0]} to ${todo[todo.length - 1]}` : "none";
      const firstPos = todo.length ? licenses.indexOf(todo[0]) + 1 : 0;
      log(`OC licenses: ${licenses.length}; already stored: ${done.size}; this batch: ${todo.length} (licenses ${range}, starting at #${firstPos} of the sorted list)`);
      log(`pacing: start ${settings.startConcurrency}, max ${settings.maxConcurrency} parallel; window ${settings.window}; ` +
        `halve above ${settings.slowRatio}x baseline, pause ${settings.verySlowPauseMs / 1000}s above ${settings.verySlowRatio}x; verify ${VERIFY_CONCURRENCY} parallel`);
      await w("set plan", db.from("raw_dre_fetch_batches").update({
        bulk_file_id: bulkId, planned_count: todo.length, first_license: todo[0] ?? null, last_license: todo[todo.length - 1] ?? null,
      }).eq("id", batchId));
      lines.push(`- Licenses ${range} (#${firstPos}–#${firstPos + todo.length - 1} of ${licenses.length}; ${done.size} were already stored)`);

      const result = await runFetch(todo, {
        fetchPage,
        storePage: async (path, gz) => { await q("upload page", db.storage.from(BUCKET).upload(path, gz, { contentType: "application/gzip" })); },
        downloadStored,
        logPage: async (r: PageReceipt) => { await w("log page", db.from("raw_dre_page_fetches").insert({ batch_id: batchId, ...r })); },
        progress: async (p) => { await w("progress", db.from("raw_dre_fetch_batches").update({
          attempted: p.attempted, ok_count: p.ok, not_found_count: p.not_found, incomplete_count: p.incomplete, error_count: p.errors,
          verify_failed_count: p.verify_failed, window_median_ms: p.window_median_ms, window_ratio: p.window_ratio,
          baseline_ms: p.baseline_ms, median_ms: p.median_ms, p90_ms: p.p90_ms,
          current_concurrency: p.current_concurrency, max_concurrency_used: p.max_concurrency_used,
          last_heartbeat_at: new Date().toISOString() }).eq("id", batchId)); },
        now: () => performance.now(), sleep, isoNow: () => new Date().toISOString(), log,
        externalStop: () => stopSignal,
      }, settings);
      status = result.status;
      stopReason = result.stopReason;
      const st = result.stats;
      lines.push(`| attempted | ok | not found | incomplete | errors | verify failed | baseline | median | p90 | max parallel |`,
        `|---|---|---|---|---|---|---|---|---|---|`,
        `| ${st.attempted} | ${st.ok} | ${st.not_found} | ${st.incomplete} | ${st.errors} | ${st.verify_failed} | ${result.baseline ?? "-"} ms | ${Math.round(median(result.durations))} ms | ${Math.round(p90(result.durations))} ms | ${result.maxUsed} |`);

      // 5. Every stored file of this batch must have been verified inline.
      const leftover = await unverified(batchId);
      if (leftover.length) {
        const v = await verifyAndRecord(leftover);
        lines.push(`- ${leftover.length} files were not verified inline; verified now: ${v.verified} ok, ${v.failed} failed`);
        st.verify_failed += v.failed;
      }
      const storedCount = st.ok + st.not_found + st.incomplete;
      lines.push(`- Verification: ${storedCount} stored files byte-identical to what DRE sent, ${st.verify_failed} failed (re-fetched next batch)`);
      if (st.verify_failed && status === "completed") { status = "failed"; stopReason = `${st.verify_failed} stored files failed verification (queued for re-fetch)`; }
      if (st.incomplete) lines.push(`- ${st.incomplete} incomplete pages were stored for inspection and will be re-fetched`);
    }
  } catch (e) {
    status = "failed";
    stopReason = e instanceof Error ? e.message : String(e);
    console.error(e);
  } finally {
    clearInterval(heartbeat);
    await db.from("raw_dre_fetch_batches")
      .update({ status, stop_reason: stopReason, finished_at: new Date().toISOString(), last_heartbeat_at: new Date().toISOString() })
      .eq("id", batchId);
  }

  const summary = [
    `### DRE raw ${SELFTEST ? "self-test" : "fetch"}, batch ${batchId}: ${status.toUpperCase()}`,
    stopReason ? `**Reason:** ${stopReason}` : "",
    ...lines,
    `Runtime: ${((Date.now() - t0) / 60_000).toFixed(1)} min`,
  ].filter(Boolean).join("\n");
  console.log("\n" + summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
  process.exitCode = status === "completed" ? 0 : status === "stopped" ? 2 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
