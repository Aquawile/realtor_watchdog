// Realtor search and profile, built only on the generic repository (so only
// user-readable sources are reachable).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../database.types";
import { createReader, type Row } from "./repository.ts";

type Db = SupabaseClient<Database>;

export type RealtorSummary = Pick<Row<"public_realtors">,
  "license_number" | "full_name" | "license_type" | "license_status" | "is_non_working" | "restricted_license" |
  "employing_broker_name" | "city" | "in_current_dre_file">;
const SUMMARY_COLUMNS = ["license_number", "full_name", "license_type", "license_status", "is_non_working",
  "restricted_license", "employing_broker_name", "city", "in_current_dre_file"] as const;

// Name, brokerage, or license number (PRD UC-008/UC-009).
export async function searchRealtors(db: Db, query: string, limit = 20): Promise<RealtorSummary[]> {
  const q = query.trim();
  if (!q) return [];
  const realtors = createReader(db, "public_realtors");
  const columns = [...SUMMARY_COLUMNS];
  const license = q.replace(/^(DRE\s*#?\s*)/i, "").replace(/\D/g, "");
  if (/^\d{6,8}$/.test(license)) {
    return realtors.list({ match: { license_number: license.padStart(8, "0") }, columns, limit });
  }
  // Full-text over names + brokerage (+ officer corporations); fall back to a
  // substring match on the name for partial words.
  const found = await realtors.list({ textSearch: { column: "search_vector", query: q }, columns, limit });
  if (found.length) return found;
  return realtors.list({ contains: { column: "full_name", value: q }, columns, limit });
}

export type RealtorProfile = {
  realtor: Row<"public_realtors">;
  dre: Row<"public_dre_records"> | null;                 // null until DRE's page for them is fetched
  affiliations: Row<"public_dre_affiliations">[];
  actions: Row<"public_dre_actions">[];                  // discipline comments + DRE hearing-document links
  rating: Row<"realtor_rating_summary"> | null;
  reviews: Row<"review_feed">[];
};

// Everything on a profile page, fetched in parallel (PRD UC-011: < 5 s).
export async function getRealtorProfile(db: Db, licenseNumber: string, reviewLimit = 20): Promise<RealtorProfile | null> {
  const [realtor, dre, affiliations, actions, rating, reviews] = await Promise.all([
    createReader(db, "public_realtors").get({ license_number: licenseNumber }),
    createReader(db, "public_dre_records").get({ license_number: licenseNumber }),
    createReader(db, "public_dre_affiliations").list({ match: { license_number: licenseNumber }, order: { column: "seq" } }),
    createReader(db, "public_dre_actions").list({ match: { license_number: licenseNumber }, order: { column: "seq" } }),
    createReader(db, "realtor_rating_summary").get({ realtor_license_number: licenseNumber }),
    createReader(db, "review_feed").list({ match: { realtor_license_number: licenseNumber },
      order: { column: "created_at", ascending: false }, limit: reviewLimit }),
  ]);
  if (!realtor) return null;
  return { realtor, dre, affiliations, actions, rating, reviews };
}
