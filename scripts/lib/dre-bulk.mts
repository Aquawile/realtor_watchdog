// Shared DRE bulk-file (CurrList.zip) download and parsing.

import type { SupabaseClient } from "@supabase/supabase-js";
import { parse } from "csv-parse/sync";
import { unzipSync } from "fflate";
import { createHash } from "node:crypto";

export const BULK_SOURCE_URL = "https://secure.dre.ca.gov/datafile/CurrList.zip";
export const SCOPE_COUNTY = "ORANGE";

export const EXPECTED_COLUMNS = [
  "multiple_license_ind", "lastname_primary", "firstname_secondary", "name_suffix",
  "lic_number", "lic_type", "lic_status", "lic_effective_date", "lic_expiration_date",
  "original_date_of_license", "related_lic_number", "related_lastname_primary",
  "related_firstname_secondary", "related_name_suffix", "related_lic_type",
  "address_1", "address_2", "city", "state", "zip_code", "foreign_nation",
  "foreign_postal_info", "county_name", "restricted_flag", "ethics_and_agency_ind",
];

export type DreRow = Record<(typeof EXPECTED_COLUMNS)[number], string>;

export async function downloadBulkZip(): Promise<{ bytes: Uint8Array; status: number }> {
  const res = await fetch(BULK_SOURCE_URL);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  return { bytes: new Uint8Array(await res.arrayBuffer()), status: res.status };
}

export function parseBulkZip(zip: Uint8Array): DreRow[] {
  const files = unzipSync(zip);
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

// Raw layer for the bulk file: store the exact downloaded bytes in the private
// 'dre-raw' bucket and log them in raw_dre_bulk_files, unless an identical
// copy (same SHA-256) is already stored. Returns the raw_dre_bulk_files id.
export async function storeBulkRaw(db: SupabaseClient, bulk: { bytes: Uint8Array; status: number }): Promise<number> {
  const sha = createHash("sha256").update(bulk.bytes).digest("hex");
  const same = await db.from("raw_dre_bulk_files").select("id").eq("sha256_raw", sha).limit(1);
  if (same.error) throw new Error(`find bulk file: ${JSON.stringify(same.error)}`);
  if (same.data.length) return same.data[0].id as number;
  const path = `bulk/${new Date().toISOString()}/CurrList.zip`;
  const up = await db.storage.from("dre-raw").upload(path, bulk.bytes, { contentType: "application/zip" });
  if (up.error) throw new Error(`upload bulk file: ${up.error.message}`);
  const row = await db.from("raw_dre_bulk_files").insert({
    source_url: BULK_SOURCE_URL, http_status: bulk.status, byte_size: bulk.bytes.length, sha256_raw: sha, storage_path: path,
  }).select("id").single();
  if (row.error) throw new Error(`log bulk file: ${JSON.stringify(row.error)}`);
  return row.data.id as number;
}

// Retention: keep the newest `keep` raw bulk files in Storage; purge older
// ones (their receipt rows stay, marked purged_at). Returns purged ids.
export async function purgeOldBulkFiles(db: SupabaseClient, keep: number): Promise<number[]> {
  if (!Number.isInteger(keep) || keep < 1) throw new Error("keep must be a whole number >= 1");
  const { data, error } = await db.from("raw_dre_bulk_files").select("id,storage_path").is("purged_at", null).order("id", { ascending: false });
  if (error) throw new Error(`list bulk files: ${JSON.stringify(error)}`);
  const old = data.slice(keep);
  for (const b of old) {
    const rm = await db.storage.from("dre-raw").remove([b.storage_path]);
    if (rm.error) throw new Error(`purge bulk file ${b.id}: ${rm.error.message}`);
    const up = await db.from("raw_dre_bulk_files").update({ purged_at: new Date().toISOString(), storage_path: null }).eq("id", b.id);
    if (up.error) throw new Error(`mark bulk file ${b.id} purged: ${JSON.stringify(up.error)}`);
  }
  return old.map((b) => b.id as number);
}

// Orange County individuals (the realtors we profile).
export const isOcIndividual = (r: DreRow) =>
  (r.lic_type === "Salesperson" || r.lic_type === "Broker") &&
  r.county_name.trim().toUpperCase() === SCOPE_COUNTY;
