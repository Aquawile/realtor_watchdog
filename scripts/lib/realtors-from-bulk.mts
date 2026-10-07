// DRE bulk file rows -> `realtors` rows, plus the fingerprint used by the
// weekly refresh to find realtors whose DRE data changed.

import { createHash } from "node:crypto";
import { isOcIndividual, type DreRow } from "./dre-bulk.mts";

export type Officership = { license_number: string; name: string };

export type RealtorRow = {
  license_number: string;
  last_name: string;
  first_name: string | null;
  name_suffix: string | null;
  license_type: "salesperson" | "broker";
  license_status: string;
  license_effective_date: string | null;
  license_expiration_date: string | null;
  original_license_date: string | null;
  restricted_license: boolean;
  employing_broker_license_number: string | null;
  employing_broker_name: string | null;
  officer_of: Officership[];
  city: string | null;
  county: string | null;
};

const blank = (s: string | undefined) => (s && s.trim() !== "" ? s.trim() : null);

// DRE bulk-file dates are YYYYMMDD.
export function bulkDate(s: string): string | null {
  const v = blank(s);
  if (!v) return null;
  if (!/^\d{8}$/.test(v)) throw new Error(`unexpected DRE date: ${v}`);
  return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
}

// Individuals are "first last suffix". Corporation names that don't fit the
// first column continue in the second, split on a word boundary.
export function relatedName(r: DreRow): string | null {
  const last = blank(r.related_lastname_primary);
  const first = blank(r.related_firstname_secondary);
  if (!last) return null;
  if (r.related_lic_type === "Corporation") return [last, first].filter(Boolean).join(" ");
  return [first, last, blank(r.related_name_suffix)].filter(Boolean).join(" ");
}

// Orange County individuals, keyed by license number, with the corporations
// each broker is an officer of (from the file's Officer rows).
export function buildScope(rows: DreRow[]): Map<string, RealtorRow> {
  const officerOf = new Map<string, Officership[]>();
  for (const r of rows) {
    if (r.lic_type !== "Officer" || !blank(r.related_lic_number)) continue;
    const list = officerOf.get(r.lic_number.trim()) ?? [];
    list.push({ license_number: r.related_lic_number.trim(), name: relatedName(r) ?? "" });
    officerOf.set(r.lic_number.trim(), list);
  }
  const scope = new Map<string, RealtorRow>();
  for (const r of rows) {
    if (!isOcIndividual(r)) continue;
    const lic = r.lic_number.trim();
    if (scope.has(lic)) throw new Error(`duplicate individual license ${lic}`);
    scope.set(lic, {
      license_number: lic,
      last_name: r.lastname_primary.trim(),
      first_name: blank(r.firstname_secondary),
      name_suffix: blank(r.name_suffix),
      license_type: r.lic_type === "Broker" ? "broker" : "salesperson",
      license_status: r.lic_status.trim(),
      license_effective_date: bulkDate(r.lic_effective_date),
      license_expiration_date: bulkDate(r.lic_expiration_date),
      original_license_date: bulkDate(r.original_date_of_license),
      restricted_license: r.restricted_flag.trim() === "Y",
      employing_broker_license_number: blank(r.related_lic_number),
      employing_broker_name: relatedName(r),
      officer_of: (officerOf.get(lic) ?? []).sort((a, b) => a.license_number.localeCompare(b.license_number)),
      city: blank(r.city),
      county: blank(r.county_name),
    });
  }
  return scope;
}

// Fingerprint of everything DRE says about a realtor in the bulk file. Same
// data -> same fingerprint, so the weekly refresh only rewrites changed rows.
export function fingerprint(row: RealtorRow): string {
  const canonical = [
    row.license_number, row.last_name, row.first_name, row.name_suffix, row.license_type, row.license_status,
    row.license_effective_date, row.license_expiration_date, row.original_license_date, row.restricted_license,
    row.employing_broker_license_number, row.employing_broker_name,
    row.officer_of.map((o) => [o.license_number, o.name]), row.city, row.county,
  ];
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
