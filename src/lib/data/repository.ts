// Generic, typed data access over Supabase, reused at every step of the user
// journey (search, profiles, reviews, comments, reactions, reports, profile
// settings, moderation).
//
//   const realtors = createReader(db, "public_realtors");
//   await realtors.list({ match: { city: "IRVINE" }, limit: 20 });
//   const reviews = createRepository(db, "reviews");
//   await reviews.insert({ realtor_license_number, author_id, relationship_tag: "buyer", rating: 5, body });
//
// Two layers keep users away from raw/internal data:
//   1. Types: T can only be a source listed in READABLE / WRITABLE below.
//      Raw and internal tables (raw_*, dre_* base tables, realtors, runs...)
//      are not assignable, so such code doesn't compile.
//   2. Database: those tables have no grants for anon/authenticated, and
//      Row Level Security limits what each user can see and change.
//
// Runtime has no imports (types only), so the module also loads under node's
// test runner.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../database.types";

type Schema = Database["public"];
type TableName = keyof Schema["Tables"];
type ViewName = keyof Schema["Views"];

// Sources the app may read as a user (public views + user-owned tables under RLS).
export const READABLE = [
  "public_realtors", "public_dre_records", "public_dre_affiliations", "public_dre_actions",
  "review_feed", "comment_feed", "realtor_rating_summary", "public_profiles",
  "profiles", "reviews", "comments", "review_reactions", "comment_reactions", "reports", "review_documents",
] as const satisfies readonly (TableName | ViewName)[];

// Tables the app may write as a user (RLS decides which rows/columns).
export const WRITABLE = [
  "profiles", "reviews", "comments", "review_reactions", "comment_reactions", "reports", "review_documents",
] as const satisfies readonly TableName[];

export type Readable = (typeof READABLE)[number];
export type Writable = (typeof WRITABLE)[number];

export type Row<S extends Readable> =
  S extends TableName ? Schema["Tables"][S]["Row"] : S extends ViewName ? Schema["Views"][S]["Row"] : never;
export type Insert<S extends Writable> = Schema["Tables"][S]["Insert"];
export type Update<S extends Writable> = Schema["Tables"][S]["Update"];

export type ListOptions<R> = {
  match?: Partial<R>;
  // Full-text search on a tsvector column (e.g. public_realtors.search_vector).
  textSearch?: { column: keyof R & string; query: string };
  // Case-insensitive substring match (uses trigram indexes where present).
  contains?: { column: keyof R & string; value: string };
  // Only these columns (default: all).
  columns?: (keyof R & string)[];
  order?: { column: keyof R & string; ascending?: boolean };
  limit?: number;
  offset?: number;
};

export class DataError extends Error {
  readonly code?: string;
  readonly details?: unknown;
  constructor(message: string, code?: string, details?: unknown) {
    super(message);
    this.name = "DataError";
    this.code = code;
    this.details = details;
  }
}

type Db = SupabaseClient<Database>;
type Result<T> = { data: T; error: { message: string; code?: string; details?: unknown } | null };

function unwrap<T>(op: string, source: string, res: Result<T>): T {
  if (res.error) throw new DataError(`${op} ${source}: ${res.error.message}`, res.error.code, res.error.details);
  return res.data;
}

// supabase-js can't resolve generic table names at the type level; the public
// API stays fully typed, the query builder is used untyped internally.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyQuery = any;
const from = (db: Db, source: string): AnyQuery => (db as unknown as { from: (s: string) => AnyQuery }).from(source);
const applyMatch = (q: AnyQuery, match?: object) => (match && Object.keys(match).length ? q.match(match) : q);

export function createReader<S extends Readable>(db: Db, source: S) {
  type R = Row<S>;
  return {
    source,
    async list(opts: ListOptions<R> = {}): Promise<R[]> {
      let q = applyMatch(from(db, source).select(opts.columns?.join(",") ?? "*"), opts.match);
      if (opts.textSearch) q = q.textSearch(opts.textSearch.column, opts.textSearch.query, { type: "websearch", config: "simple" });
      if (opts.contains) q = q.ilike(opts.contains.column, `%${opts.contains.value.replace(/[%_\\]/g, (c: string) => `\\${c}`)}%`);
      if (opts.order) q = q.order(opts.order.column, { ascending: opts.order.ascending ?? true });
      if (opts.limit !== undefined) q = q.range(opts.offset ?? 0, (opts.offset ?? 0) + opts.limit - 1);
      return unwrap("list", source, await q) as R[];
    },
    async get(match: Partial<R>): Promise<R | null> {
      return unwrap("get", source, await applyMatch(from(db, source).select("*"), match).maybeSingle()) as R | null;
    },
    async count(match?: Partial<R>): Promise<number> {
      const res = await applyMatch(from(db, source).select("*", { count: "exact", head: true }), match);
      unwrap("count", source, res);
      return (res as { count: number | null }).count ?? 0;
    },
  };
}

export function createRepository<S extends Writable>(db: Db, table: S) {
  type R = Row<S>;
  return {
    ...createReader(db, table),
    async insert(rows: Insert<S> | Insert<S>[]): Promise<R[]> {
      return unwrap("insert", table, await from(db, table).insert(rows).select()) as R[];
    },
    async update(match: Partial<R>, patch: Update<S>): Promise<R[]> {
      if (!Object.keys(match).length) throw new DataError(`update ${table}: refusing to update without a match`);
      return unwrap("update", table, await applyMatch(from(db, table).update(patch), match).select()) as R[];
    },
    async remove(match: Partial<R>): Promise<number> {
      if (!Object.keys(match).length) throw new DataError(`remove ${table}: refusing to delete without a match`);
      return (unwrap("remove", table, await applyMatch(from(db, table).delete(), match).select()) as R[]).length;
    },
  };
}
