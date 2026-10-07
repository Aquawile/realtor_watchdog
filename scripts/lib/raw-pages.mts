// Reading and bundling raw DRE page files in the dre-raw bucket.
//
// A raw page is stored either as a single gzip file (storage_path) or as an
// entry inside a .tar bundle (bundle_id + bundle_entry). Bytes are identical
// either way, and every receipt keeps the SHA-256 of the uncompressed page.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { createTar, readTar } from "./tar.mts";

const BUCKET = "dre-raw";
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type RawReceipt = {
  id: number;
  license_number: string;
  sha256_raw: string;
  byte_size: number;
  storage_path: string | null;
  bundle_id: number | null;
  bundle_entry: string | null;
};
export const RAW_RECEIPT_COLUMNS = "id,license_number,sha256_raw,byte_size,storage_path,bundle_id,bundle_entry";

async function download(db: SupabaseClient, path: string, tries = 3): Promise<Uint8Array> {
  for (let i = 1; ; i++) {
    const { data, error } = await db.storage.from(BUCKET).download(path);
    if (!error) return new Uint8Array(await data.arrayBuffer());
    if (i >= tries) throw new Error(`download ${path}: ${error.message}`);
    await sleep(2000 * i);
  }
}

// Uncompressed page bytes, checked against the receipt's checksum and size.
function checkedPage(r: RawReceipt, gz: Uint8Array): Uint8Array {
  const raw = gunzipSync(gz);
  if (raw.length !== r.byte_size || sha256(raw) !== r.sha256_raw) {
    throw new Error(`raw page for ${r.license_number} (receipt ${r.id}) doesn't match its checksum`);
  }
  return raw;
}

// Calls onPage(receipt, verifiedPageBytes) for every receipt, downloading each
// bundle once. Bundles are processed `concurrency` at a time.
export async function loadRawPages<R extends RawReceipt>(
  db: SupabaseClient, receipts: R[],
  onPage: (r: R, page: Uint8Array) => Promise<void> | void,
  opts: { concurrency?: number; onError?: (r: R, e: Error) => void } = {},
) {
  const bundleIds = [...new Set(receipts.map((r) => r.bundle_id).filter((x): x is number => x !== null))];
  const bundlePaths = new Map<number, string>();
  for (let i = 0; i < bundleIds.length; i += 200) {
    const { data, error } = await db.from("raw_dre_bundles").select("id,storage_path").in("id", bundleIds.slice(i, i + 200));
    if (error) throw new Error(`load bundles: ${JSON.stringify(error)}`);
    for (const b of data) bundlePaths.set(b.id, b.storage_path);
  }
  // Work units: one per bundle, plus small groups of single files.
  const units: R[][] = [];
  const byBundle = new Map<number, R[]>();
  const singles: R[] = [];
  for (const r of receipts) {
    if (r.bundle_id !== null) (byBundle.get(r.bundle_id) ?? byBundle.set(r.bundle_id, []).get(r.bundle_id)!).push(r);
    else singles.push(r);
  }
  units.push(...byBundle.values());
  for (let i = 0; i < singles.length; i += 20) units.push(singles.slice(i, i + 20));

  const fail = (r: R, e: unknown) => {
    const err = e instanceof Error ? e : new Error(String(e));
    if (opts.onError) opts.onError(r, err); else throw err;
  };
  const queue = [...units];
  await Promise.all(Array.from({ length: opts.concurrency ?? 6 }, async () => {
    for (let unit = queue.shift(); unit; unit = queue.shift()) {
      if (unit[0].bundle_id !== null) {
        const path = bundlePaths.get(unit[0].bundle_id);
        let entries: Map<string, Uint8Array>;
        try {
          if (!path) throw new Error(`bundle ${unit[0].bundle_id} not found`);
          entries = new Map(readTar(await download(db, path)).map((e) => [e.name, e.data]));
        } catch (e) { for (const r of unit) fail(r, e); continue; }
        for (const r of unit) {
          try {
            const gz = entries.get(r.bundle_entry!);
            if (!gz) throw new Error(`entry ${r.bundle_entry} missing from bundle ${path}`);
            await onPage(r, checkedPage(r, gz));
          } catch (e) { fail(r, e); }
        }
      } else {
        await Promise.all(unit.map(async (r) => {
          try { await onPage(r, checkedPage(r, await download(db, r.storage_path!))); } catch (e) { fail(r, e); }
        }));
      }
    }
  }));
}

// Bundle a group of single-file raw pages into one .tar:
//   1. download each file and check it against its receipt
//   2. build and upload the bundle
//   3. download the bundle back and re-check every entry
//   4. register the bundle and point the receipts at it (one transaction)
//   5. only then delete the single files
// Any failure before step 4 deletes the uploaded bundle and changes nothing.
export async function bundleReceipts(db: SupabaseClient, receipts: RawReceipt[]): Promise<{ bundleId: number; path: string; entries: number; bytes: number }> {
  if (!receipts.length) throw new Error("nothing to bundle");
  if (receipts.some((r) => !r.storage_path || r.bundle_id !== null)) throw new Error("bundleReceipts expects single-file receipts only");
  const sorted = [...receipts].sort((a, b) => a.license_number.localeCompare(b.license_number) || a.id - b.id);

  // 1. Download + check.
  const gzById = new Map<number, Uint8Array>();
  const queue = [...sorted];
  await Promise.all(Array.from({ length: 12 }, async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      const gz = await download(db, r.storage_path!);
      checkedPage(r, gz);
      gzById.set(r.id, gz);
    }
  }));

  // 2. Build + upload. Entry name: <license>/<original file name>.
  const entryOf = (r: RawReceipt) => `${r.license_number}/${r.storage_path!.split("/").pop()}`;
  const tar = createTar(sorted.map((r) => ({ name: entryOf(r), data: gzById.get(r.id)! })));
  const first = sorted[0].license_number, last = sorted[sorted.length - 1].license_number;
  const path = `bundles/pages/${first}-${last}_${new Date().toISOString()}.tar`;
  const up = await db.storage.from(BUCKET).upload(path, tar, { contentType: "application/x-tar" });
  if (up.error) throw new Error(`upload bundle: ${up.error.message}`);

  try {
    // 3. Read back + re-check every entry.
    const back = await download(db, path);
    if (sha256(back) !== sha256(tar)) throw new Error("bundle changed during upload");
    const entries = new Map(readTar(back).map((e) => [e.name, e.data]));
    if (entries.size !== sorted.length) throw new Error(`bundle has ${entries.size} entries, expected ${sorted.length}`);
    for (const r of sorted) {
      const gz = entries.get(entryOf(r));
      if (!gz) throw new Error(`entry ${entryOf(r)} missing after upload`);
      checkedPage(r, gz);
    }
  } catch (e) {
    await db.storage.from(BUCKET).remove([path]);
    throw e;
  }

  // 4. Register + attach (atomic).
  const reg = await db.from("raw_dre_bundles").insert({
    storage_path: path, byte_size: tar.length, sha256: sha256(tar), entry_count: sorted.length,
    first_license: first, last_license: last, verified_at: new Date().toISOString(),
  }).select("id").single();
  if (reg.error) { await db.storage.from(BUCKET).remove([path]); throw new Error(`register bundle: ${JSON.stringify(reg.error)}`); }
  const bundleId = reg.data.id as number;
  const att = await db.rpc("raw_dre_attach_bundle", { p_bundle_id: bundleId, p: sorted.map((r) => ({ id: r.id, entry: entryOf(r) })) });
  if (att.error) throw new Error(`attach receipts to bundle ${bundleId}: ${JSON.stringify(att.error)} (bundle kept; single files untouched)`);

  // 5. Remove the single files (now redundant).
  const paths = sorted.map((r) => r.storage_path!);
  for (let i = 0; i < paths.length; i += 500) {
    const rm = await db.storage.from(BUCKET).remove(paths.slice(i, i + 500));
    if (rm.error) throw new Error(`remove single files: ${rm.error.message} (bundle ${bundleId} is complete and attached)`);
  }
  return { bundleId, path, entries: sorted.length, bytes: tar.length };
}
