// Raw-layer maintenance for DRE data.
//
//   --bundle              bundle single-file raw pages into .tar bundles (1,000 pages each),
//                         verified before the single files are deleted (see lib/raw-pages.mts)
//   --archive-headers     move fetch headers + request URLs out of the database into one
//                         gzipped JSON-lines file in Storage (verified, registered in raw_archives)
//   --show <license>      print a licensee's latest raw page (HTML) to stdout
//   --purge-bulk [--keep N]  keep the latest N raw bulk files (default 6), purge older ones from Storage
//
// Usage: node --env-file=.env.local scripts/maintain-dre-raw.mts <task>

import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { purgeOldBulkFiles } from "./lib/dre-bulk.mts";
import { bundleReceipts, loadRawPages, RAW_RECEIPT_COLUMNS, type RawReceipt } from "./lib/raw-pages.mts";

const BUNDLE_SIZE = 1000;
const db = createClient(process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false } });
const log = (m: string) => console.error(`[${new Date().toISOString()}] ${m}`);
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const summary = (s: string) => { console.error("\n" + s); if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, s + "\n"); };

async function all<T>(select: string, filter: (q: any) => any): Promise<T[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await filter(db.from("raw_dre_page_fetches").select(select)).order("id").range(from, from + 999);
    if (error) throw new Error(JSON.stringify(error));
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

if (process.argv.includes("--bundle")) {
  // Verified single files only; unverified / verify_failed ones are left for re-fetching.
  const singles = await all<RawReceipt>(RAW_RECEIPT_COLUMNS, (q) => q.not("storage_path", "is", null).not("verified_at", "is", null));
  singles.sort((a, b) => a.license_number.localeCompare(b.license_number) || a.id - b.id);
  log(`single-file raw pages to bundle: ${singles.length}`);
  let bundles = 0, pages = 0, bytes = 0;
  for (let i = 0; i < singles.length; i += BUNDLE_SIZE) {
    const r = await bundleReceipts(db, singles.slice(i, i + BUNDLE_SIZE));
    bundles++; pages += r.entries; bytes += r.bytes;
    log(`bundle ${r.bundleId}: ${r.entries} pages, ${(r.bytes / 1048576).toFixed(1)} MB, verified; single files removed (${pages}/${singles.length})`);
  }
  summary(`### Raw page bundling: ${bundles} bundles, ${pages} pages, ${(bytes / 1048576).toFixed(1)} MB (every entry verified before single files were removed)`);
} else if (process.argv.includes("--archive-headers")) {
  type Row = { id: number; requested_url: string | null; response_headers: unknown };
  const rows = await all<Row>("id,requested_url,response_headers", (q) => q.or("response_headers.not.is.null,requested_url.not.is.null"));
  log(`receipts with headers/URL to archive: ${rows.length}`);
  if (!rows.length) { summary("### Header archive: nothing to archive"); process.exit(0); }
  const body = gzipSync(new TextEncoder().encode(rows.map((r) => JSON.stringify(r)).join("\n") + "\n"), { level: 9 });
  const path = `archive/raw_dre_page_fetches_headers_${new Date().toISOString()}.jsonl.gz`;
  const up = await db.storage.from("dre-raw").upload(path, body, { contentType: "application/gzip" });
  if (up.error) throw new Error(`upload archive: ${up.error.message}`);
  // Verify: download back, same bytes, same row count, ids match.
  const { data, error } = await db.storage.from("dre-raw").download(path);
  if (error) throw new Error(`download archive: ${error.message}`);
  const back = new Uint8Array(await data.arrayBuffer());
  const lines = new TextDecoder().decode(gunzipSync(back)).trim().split("\n");
  if (sha256(back) !== sha256(body) || lines.length !== rows.length || JSON.parse(lines.at(-1)!).id !== rows.at(-1)!.id) {
    await db.storage.from("dre-raw").remove([path]);
    throw new Error("archive verification failed; nothing changed");
  }
  const reg = await db.from("raw_archives").insert({ storage_path: path, description: "raw_dre_page_fetches.requested_url + response_headers (JSON lines: id, requested_url, response_headers)", byte_size: body.length, sha256: sha256(body), row_count: rows.length });
  if (reg.error) throw new Error(`register archive: ${JSON.stringify(reg.error)}`);
  summary(`### Header archive: ${rows.length} receipts → ${path} (${(body.length / 1048576).toFixed(1)} MB, verified). The columns can now be dropped.`);
} else if (arg("show")) {
  const license = arg("show")!;
  const [latest] = (await all<RawReceipt>(RAW_RECEIPT_COLUMNS, (q) => q.eq("license_number", license).in("outcome", ["ok", "not_found", "incomplete"]))).slice(-1);
  if (!latest) throw new Error(`no stored raw page for ${license}`);
  await loadRawPages(db, [latest], (_r, page) => { process.stdout.write(new TextDecoder("latin1").decode(page)); });
} else if (process.argv.includes("--purge-bulk")) {
  const keep = Number(arg("keep") ?? 6);
  const purged = await purgeOldBulkFiles(db, keep);
  summary(`### Raw bulk files: kept latest ${keep}, purged ${purged.length} older (${purged.join(", ") || "none"})`);
} else {
  console.error("usage: maintain-dre-raw.mts --bundle | --archive-headers | --show <license> | --purge-bulk [--keep N]");
  process.exit(2);
}
