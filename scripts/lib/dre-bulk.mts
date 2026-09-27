// Shared DRE bulk-file (CurrList.zip) download and parsing.

import { parse } from "csv-parse/sync";
import { unzipSync } from "fflate";

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

// Orange County individuals (the realtors we profile).
export const isOcIndividual = (r: DreRow) =>
  (r.lic_type === "Salesperson" || r.lic_type === "Broker") &&
  r.county_name.trim().toUpperCase() === SCOPE_COUNTY;
