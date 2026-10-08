// Raw-layer maintenance for DRE data.
//
//   --bundle              bundle single-file raw pages into .tar bundles (1,000 pages each),
//                         verified before the single files are deleted (see lib/raw-pages.mts)
//   (Fetch headers + request URLs were archived on 2026-10-07 and dropped from the
//    database; the archive is registered in raw_archives.)
//   --show <license>      print a licensee's latest raw page (HTML) to stdout
//   --purge-bulk [--keep N]  keep the latest N raw bulk files (default 6), purge older ones from Storage
//
// Usage: node --env-file=.env.local scripts/maintain-dre-raw.mts <task>

import { createClient } from "@supabase/supabase-js";
import { appendFileSync } from "node:fs";
import { purgeOldBulkFiles } from "./lib/dre-bulk.mts";
import { bundleReceipts, loadRawPages, RAW_RECEIPT_COLUMNS, type RawReceipt } from "./lib/raw-pages.mts";

const BUNDLE_SIZE = 1000;
const db = createClient(process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false } });
const log = (m: string) => console.error(`[${new Date().toISOString()}] ${m}`);
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
  console.error("usage: maintain-dre-raw.mts --bundle | --show <license> | --purge-bulk [--keep N]");
  process.exit(2);
}
