// Runtime tests for the generic repository against a simulated Supabase
// client that records every query-builder call.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../src/lib/database.types.ts";
import { createReader, createRepository, DataError } from "../../src/lib/data/repository.ts";

type Call = [string, ...unknown[]];
function fakeDb(result: { data?: unknown; error?: { message: string; code?: string } | null; count?: number } = {}) {
  const calls: Call[] = [];
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "match", "order", "range", "textSearch", "ilike", "insert", "update", "delete", "maybeSingle"]) {
    builder[m] = (...args: unknown[]) => { calls.push([m, ...args]); return builder; };
  }
  builder.then = (resolve: (v: unknown) => void) => resolve({ data: result.data ?? [], error: result.error ?? null, count: result.count ?? null });
  const db = { from: (t: string) => { calls.push(["from", t]); return builder; } };
  return { db: db as unknown as SupabaseClient<Database>, calls };
}

test("list: select, match, order, paging map onto the query", async () => {
  const f = fakeDb({ data: [{ license_number: "01234567" }] });
  const rows = await createReader(f.db, "public_realtors").list({
    match: { city: "IRVINE" }, order: { column: "full_name", ascending: false }, limit: 20, offset: 40, columns: ["license_number", "full_name"],
  });
  assert.deepEqual(rows, [{ license_number: "01234567" }]);
  assert.deepEqual(f.calls, [
    ["from", "public_realtors"], ["select", "license_number,full_name"], ["match", { city: "IRVINE" }],
    ["order", "full_name", { ascending: false }], ["range", 40, 59],
  ]);
});

test("search: full-text uses websearch syntax; substring search escapes user input", async () => {
  const f = fakeDb();
  await createReader(f.db, "public_realtors").list({ textSearch: { column: "search_vector", query: "coldwell banker" } });
  assert.deepEqual(f.calls.find((c) => c[0] === "textSearch"), ["textSearch", "search_vector", "coldwell banker", { type: "websearch", config: "simple" }]);
  const g = fakeDb();
  await createReader(g.db, "public_realtors").list({ contains: { column: "full_name", value: "50%_off\\" } });
  assert.deepEqual(g.calls.find((c) => c[0] === "ilike"), ["ilike", "full_name", "%50\\%\\_off\\\\%"]);
});

test("get uses maybeSingle; count asks for an exact head-only count", async () => {
  const f = fakeDb({ data: { license_number: "01234567" } });
  assert.deepEqual(await createReader(f.db, "public_dre_records").get({ license_number: "01234567" }), { license_number: "01234567" });
  assert.ok(f.calls.some((c) => c[0] === "maybeSingle"));
  const g = fakeDb({ count: 42 });
  assert.equal(await createReader(g.db, "review_feed").count({ realtor_license_number: "01234567" }), 42);
  assert.deepEqual(g.calls[1], ["select", "*", { count: "exact", head: true }]);
});

test("writes return the written rows; update/remove refuse to run without a match", async () => {
  const f = fakeDb({ data: [{ id: "r1" }] });
  const reviews = createRepository(f.db, "reviews");
  assert.deepEqual(await reviews.insert({ realtor_license_number: "01234567", author_id: "u", relationship_tag: "buyer", rating: 5, body: "Great" }), [{ id: "r1" }]);
  assert.deepEqual(f.calls.slice(1, 3).map((c) => c[0]), ["insert", "select"]);
  await assert.rejects(reviews.update({}, { body: "x" }), /refusing to update without a match/);
  await assert.rejects(reviews.remove({}), /refusing to delete without a match/);
});

test("database errors surface as DataError with the code (e.g. RLS refusals)", async () => {
  const f = fakeDb({ error: { message: "new row violates row-level security policy", code: "42501" } });
  const err = await createRepository(f.db, "reviews").insert({ realtor_license_number: "01234567", author_id: "u", relationship_tag: "seller", rating: 1, body: "x" })
    .then(() => null, (e) => e);
  assert.ok(err instanceof DataError);
  assert.equal(err.code, "42501");
  assert.match(err.message, /insert reviews: new row violates row-level security policy/);
});
