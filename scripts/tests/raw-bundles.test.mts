// Tests for the .tar format and raw-page bundling against a simulated
// Supabase (Storage + the few table calls bundling makes). Bundling deletes
// files, so these focus on "never delete unless every page verified".
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import type { SupabaseClient } from "@supabase/supabase-js";
import { bundleReceipts, loadRawPages, type RawReceipt } from "../lib/raw-pages.mts";
import { createTar, readTar } from "../lib/tar.mts";

const enc = (s: string) => new TextEncoder().encode(s);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

test("tar: round trip, and standard tar tools read our bundles", () => {
  const entries = [
    { name: "01234567/2026-09-28T21:26:48.503Z.html.gz", data: gzipSync(enc("page one")) },
    { name: "07654321/2026-09-28T21:27:00.000Z.html.gz", data: new Uint8Array(0) },
    { name: "x/big.bin", data: new Uint8Array(1300).map((_, i) => i % 251) },
  ];
  const tar = createTar(entries);
  assert.equal(tar.length % 512, 0);
  assert.deepEqual(readTar(tar).map((e) => [e.name, sha(e.data)]), entries.map((e) => [e.name, sha(e.data)]));
  const dir = mkdtempSync(join(tmpdir(), "tar-"));
  writeFileSync(join(dir, "b.tar"), tar);
  const listed = execFileSync("tar", ["-tf", join(dir, "b.tar")], { encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(listed, entries.map((e) => e.name));
  assert.throws(() => createTar([entries[0], entries[0]]), /duplicate/);
  const corrupt = tar.slice(); corrupt[10] ^= 1;
  assert.throws(() => readTar(corrupt), /corrupt tar header/);
});

// ---- simulated Supabase ------------------------------------------------------
function fakeDb(opts: { corruptUpload?: (path: string) => boolean } = {}) {
  const files = new Map<string, Uint8Array>();
  const bundles: Record<string, unknown>[] = [];
  const attached: { bundle: number; ids: number[] }[] = [];
  const removed: string[] = [];
  const db = {
    storage: {
      from: () => ({
        upload: async (path: string, data: Uint8Array) => {
          files.set(path, opts.corruptUpload?.(path) ? data.map((b, i) => (i === data.length - 100 ? b ^ 1 : b)) : data);
          return { data: { path }, error: null };
        },
        download: async (path: string) => files.has(path)
          ? { data: new Blob([files.get(path)! as BlobPart]), error: null } : { data: null, error: { message: "not found" } },
        remove: async (paths: string[]) => { for (const p of paths) { files.delete(p); removed.push(p); } return { data: [], error: null }; },
      }),
    },
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => ({
        select: () => ({ single: async () => { const id = bundles.length + 1; bundles.push({ id, ...row }); return { data: { id }, error: null }; } }),
      }),
      select: () => ({ in: async (_c: string, ids: number[]) => ({ data: bundles.filter((b) => ids.includes(b.id as number)).map((b) => ({ id: b.id, storage_path: b.storage_path })), error: null }) }),
      table,
    }),
    rpc: async (_fn: string, args: { p_bundle_id: number; p: { id: number }[] }) => {
      attached.push({ bundle: args.p_bundle_id, ids: args.p.map((x) => x.id) });
      return { data: args.p.length, error: null };
    },
  };
  return { db: db as unknown as SupabaseClient, files, bundles, attached, removed };
}

function seed(f: ReturnType<typeof fakeDb>, n: number): RawReceipt[] {
  return Array.from({ length: n }, (_, i) => {
    const lic = String(10_000_000 + i);
    const page = enc(`<html>License ID: ${lic} >>>> Public information request complete <<<<</html>`);
    const path = `pages/${lic}/2026-10-01T00:00:00.000Z.html.gz`;
    f.files.set(path, gzipSync(page));
    return { id: i + 1, license_number: lic, sha256_raw: sha(page), byte_size: page.length, storage_path: path, bundle_id: null, bundle_entry: null };
  });
}

test("bundling: verified bundle uploaded and attached, then single files deleted; pages readable from the bundle", async () => {
  const f = fakeDb();
  const receipts = seed(f, 25);
  const r = await bundleReceipts(f.db, receipts);
  assert.equal(r.entries, 25);
  assert.equal(f.attached.length, 1);
  assert.equal(f.removed.length, 25, "single files removed only after attach");
  assert.ok(f.files.has(r.path));
  const after = receipts.map((x) => ({ ...x, storage_path: null, bundle_id: r.bundleId, bundle_entry: `${x.license_number}/2026-10-01T00:00:00.000Z.html.gz` }));
  const seen: string[] = [];
  await loadRawPages(f.db, after, (rec, page) => { assert.ok(new TextDecoder().decode(page).includes(rec.license_number)); seen.push(rec.license_number); });
  assert.equal(seen.length, 25);
});

test("bundling: a single file that doesn't match its checksum stops everything; nothing attached or deleted", async () => {
  const f = fakeDb();
  const receipts = seed(f, 10);
  f.files.set(receipts[3].storage_path!, gzipSync(enc("tampered")));
  await assert.rejects(bundleReceipts(f.db, receipts), /doesn't match its checksum/);
  assert.equal(f.attached.length, 0);
  assert.equal(f.removed.length, 0);
  assert.equal(f.bundles.length, 0);
});

test("bundling: a bundle damaged in upload is detected, removed, and nothing is attached or deleted", async () => {
  const f = fakeDb({ corruptUpload: (p) => p.startsWith("bundles/") });
  const receipts = seed(f, 10);
  await assert.rejects(bundleReceipts(f.db, receipts), /changed during upload|doesn't match|corrupt/);
  assert.equal(f.attached.length, 0);
  assert.deepEqual(f.removed.filter((p) => p.startsWith("pages/")), [], "no single page deleted");
  assert.equal([...f.files.keys()].filter((p) => p.startsWith("bundles/")).length, 0, "damaged bundle cleaned up");
});

test("loading: mixed bundled + single files, and a corrupt page is reported, not silently used", async () => {
  const f = fakeDb();
  const receipts = seed(f, 6);
  const r = await bundleReceipts(f.db, receipts.slice(0, 4));
  const mixed: RawReceipt[] = [
    ...receipts.slice(0, 4).map((x) => ({ ...x, storage_path: null, bundle_id: r.bundleId, bundle_entry: `${x.license_number}/2026-10-01T00:00:00.000Z.html.gz` })),
    ...receipts.slice(4),
  ];
  f.files.set(receipts[5].storage_path!, gzipSync(enc("tampered")));
  const ok: string[] = [], bad: string[] = [];
  await loadRawPages(f.db, mixed, (x) => { ok.push(x.license_number); }, { onError: (x) => bad.push(x.license_number) });
  assert.equal(ok.length, 5);
  assert.deepEqual(bad, [receipts[5].license_number]);
});
