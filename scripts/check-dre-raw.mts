// Hygiene + health check for the DRE raw layer, run after each batch.
//
// Usage: node --env-file=.env.local scripts/check-dre-raw.mts <batch id>
//
// 1. Batch: completed, every planned page attempted, no errors / incomplete /
//    verification failures.
// 2. Hygiene of that batch's pages: each stored file is downloaded, unpacked,
//    checksummed against its receipt, confirmed to be the complete record of
//    the license requested, and not byte-identical to another license's page.
// 3. Overall health: no running / abandoned / failed batches, every stored
//    file verified, unique licenses stored, latest bulk file.
// Exit code 0 = PASS, 1 = FAIL.

import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

// Batch 2 failed before fetching anything (fixed bug); it is expected history.
const KNOWN_FAILED_BATCHES = new Set([2]);

const batchId = Number(process.argv[2]);
if (!Number.isInteger(batchId)) throw new Error("usage: check-dre-raw.mts <batch id>");
const db = createClient(process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false } });

type Receipt = { id: number; batch_id: number; license_number: string; storage_path: string | null; sha256_raw: string | null;
  outcome: string; verified_at: string | null };

async function receipts(filter?: (q: any) => any): Promise<Receipt[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: Receipt[] = [];
  for (let from = 0; ; from += 1000) {
    let q = db.from("raw_dre_page_fetches").select("id,batch_id,license_number,storage_path,sha256_raw,outcome,verified_at")
      .order("id").range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(JSON.stringify(error));
    out.push(...(data as Receipt[]));
    if (data.length < 1000) break;
  }
  return out;
}

// The license number shown in the page's "License ID:" row.
const pageLicense = (html: string) => html.match(/License ID:<\/strong>[\s\S]*?<td[^>]*>[\s\S]*?(\d{8})/i)?.[1] ?? null;

const fails: string[] = [];

// 1. The batch.
const { data: batchRows, error: be } = await db.from("raw_dre_fetch_batches").select("*").eq("id", batchId);
if (be || !batchRows?.length) throw new Error(`batch ${batchId} not found`);
const b = batchRows[0];
console.log(`BATCH ${b.id}: ${b.status}; ${b.attempted}/${b.planned_count} attempted (ok ${b.ok_count}, not found ${b.not_found_count}, ` +
  `incomplete ${b.incomplete_count}, errors ${b.error_count}, verify failed ${b.verify_failed_count}); licenses ${b.first_license}..${b.last_license}; ` +
  `DRE median ${b.median_ms} ms, p90 ${b.p90_ms} ms`);
if (b.status !== "completed") fails.push(`batch status is ${b.status}: ${b.stop_reason}`);
if (b.attempted !== b.planned_count) fails.push(`attempted ${b.attempted} != planned ${b.planned_count}`);
if (b.error_count || b.incomplete_count || b.verify_failed_count) fails.push("batch has errors, incomplete pages or verification failures");

// 2. Hygiene of this batch's pages.
const mine = await receipts((q) => q.eq("batch_id", batchId));
const others = await receipts((q) => q.neq("batch_id", batchId).not("sha256_raw", "is", null));
const shaOwner = new Map(others.map((r) => [r.sha256_raw, r.license_number]));
let checked = 0;
const queue = [...mine];
await Promise.all(Array.from({ length: 10 }, async () => {
  for (let r = queue.shift(); r; r = queue.shift()) {
    if (r.outcome !== "ok" && r.outcome !== "not_found") { fails.push(`${r.license_number}: outcome ${r.outcome}`); continue; }
    if (!r.verified_at) fails.push(`${r.license_number}: not verified`);
    const { data, error } = await db.storage.from("dre-raw").download(r.storage_path!);
    if (error) { fails.push(`${r.license_number}: download failed (${error.message})`); continue; }
    const raw = gunzipSync(new Uint8Array(await data.arrayBuffer()));
    if (createHash("sha256").update(raw).digest("hex") !== r.sha256_raw) fails.push(`${r.license_number}: checksum mismatch`);
    const owner = shaOwner.get(r.sha256_raw!);
    if (owner && owner !== r.license_number) fails.push(`${r.license_number}: byte-identical to ${owner}'s page`);
    const html = new TextDecoder("latin1").decode(raw);
    if (r.outcome === "ok") {
      if (!/Public information request complete/i.test(html)) fails.push(`${r.license_number}: no end-of-record marker`);
      const shown = pageLicense(html);
      if (shown !== r.license_number) fails.push(`${r.license_number}: page shows license ${shown}`);
    }
    checked++;
  }
}));
console.log(`HYGIENE: ${checked}/${mine.length} pages downloaded and checked (checksum, license identity, completeness, uniqueness)`);

// 3. Overall health.
const { data: batches } = await db.from("raw_dre_fetch_batches").select("id,status").order("id");
const unhealthy = (batches ?? []).filter((x) => x.status === "running" || x.status === "abandoned" ||
  (x.status === "failed" && !KNOWN_FAILED_BATCHES.has(x.id)));
if (unhealthy.length) fails.push(`unhealthy batches: ${JSON.stringify(unhealthy)}`);
const every = await receipts();
const stored = every.filter((r) => r.storage_path);
const unverified = stored.filter((r) => !r.verified_at && r.outcome !== "verify_failed").length;
if (unverified) fails.push(`${unverified} stored files were never verified`);
const okLicenses = new Set(every.filter((r) => r.outcome === "ok" || r.outcome === "not_found").map((r) => r.license_number));
const okRows = every.filter((r) => r.outcome === "ok").length;
const { data: bulk } = await db.from("raw_dre_bulk_files").select("id,fetched_at,byte_size").order("id");
const bulkBytes = (bulk ?? []).reduce((s, x) => s + x.byte_size, 0);
console.log(`HEALTH: ${batches?.length} batches, unhealthy: ${unhealthy.length}; receipts ${every.length}, stored files ${stored.length}, ` +
  `unverified ${unverified}; unique licenses stored ${okLicenses.size}` + (okRows !== okLicenses.size ? ` (${okRows - okLicenses.size} stored twice)` : "") +
  `; bulk file copies ${bulk?.length} (${(bulkBytes / 1048576).toFixed(0)} MB)`);
console.log(fails.length ? `RESULT: FAIL\n  ${fails.slice(0, 25).join("\n  ")}` : "RESULT: PASS");
process.exit(fails.length ? 1 : 0);
