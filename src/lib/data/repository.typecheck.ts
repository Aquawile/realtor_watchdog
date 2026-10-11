// Compile-time guarantees of the data layer, checked by `tsc` (npm test / CI).
// Each @ts-expect-error line MUST fail to compile; if one ever compiles, the
// type-check fails, so these rules can't silently erode. Never executed.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../database.types";
import { createReader, createRepository } from "./repository";

export function typeChecks(db: SupabaseClient<Database>) {
  // Raw and internal tables are not readable through the data layer.
  // @ts-expect-error raw receipts are server-only
  createReader(db, "raw_dre_page_fetches");
  // @ts-expect-error raw bundles are server-only
  createReader(db, "raw_dre_bundles");
  // @ts-expect-error processed base table; users read public_dre_records instead
  createReader(db, "dre_licensee_records");
  // @ts-expect-error realtors base table; users read public_realtors instead
  createReader(db, "realtors");
  // @ts-expect-error moderation log is moderator/server-only
  createReader(db, "moderation_actions");

  // Views and public data are read-only.
  // @ts-expect-error views can't be written
  createRepository(db, "public_realtors");
  // @ts-expect-error DRE facts can't be written by users
  createRepository(db, "public_dre_actions");

  // Rows, filters and columns are checked against the real schema.
  // @ts-expect-error no such column on reviews
  void createRepository(db, "reviews").insert({ realtor_license_number: "01234567", author_id: "x", relationship_tag: "buyer", rating: 5, body: "ok", bogus: 1 });
  // @ts-expect-error relationship_tag is Buyer/Seller only
  void createRepository(db, "reviews").insert({ realtor_license_number: "01234567", author_id: "x", relationship_tag: "landlord", rating: 5, body: "ok" });
  // @ts-expect-error can't order by a column the view doesn't have
  void createReader(db, "public_realtors").list({ order: { column: "dre_fingerprint" } });
  // @ts-expect-error internal columns aren't selectable from public views
  void createReader(db, "public_dre_records").list({ columns: ["unparsed_lines"] });

  // Allowed uses compile.
  void createReader(db, "public_realtors").list({ match: { city: "IRVINE" }, order: { column: "full_name" }, limit: 20 });
  void createReader(db, "review_feed").get({ id: "x" });
}
