// Field survey of every stored raw DRE page (read-only).
//
// For each field label: how many pages have it, entry counts, and the
// distinct line "shapes" (digits -> 9, letters -> a) with examples, so the
// processed columns are designed from what DRE actually returns.
//
// Usage: node --env-file=.env.local scripts/survey-dre-raw.mts [--out survey.json]

import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { readPage } from "./lib/dre-page-html.mts";

const db = createClient(process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false } });
const outIdx = process.argv.indexOf("--out");

// Latest ok fetch per license.
const latest = new Map<string, string>();
for (let from = 0; ; from += 1000) {
  const { data, error } = await db.from("raw_dre_page_fetches").select("license_number,storage_path")
    .eq("outcome", "ok").order("id").range(from, from + 999);
  if (error) throw new Error(JSON.stringify(error));
  for (const r of data) latest.set(r.license_number, r.storage_path);
  if (data.length < 1000) break;
}
console.log(`pages to survey: ${latest.size}`);

const shape = (l: string) => l.replace(/\d/g, "9").replace(/[A-Za-z]+/g, "a").replace(/(a )+a/g, "a…").slice(0, 70);
type LabelStats = { pages: number; entries: number; maxEntries: number; shapes: Map<string, { n: number; example: string }> };
const labels = new Map<string, LabelStats>();
const encodings = new Map<string, number>();
let incomplete = 0, done = 0;

const queue = [...latest.entries()];
await Promise.all(Array.from({ length: 12 }, async () => {
  for (let item = queue.shift(); item; item = queue.shift()) {
    const [license, path] = item;
    const { data, error } = await db.storage.from("dre-raw").download(path);
    if (error) throw new Error(`${license}: ${error.message}`);
    const page = readPage(gunzipSync(new Uint8Array(await data.arrayBuffer())));
    encodings.set(`${page.encoding}/${page.lineEndings}`, (encodings.get(`${page.encoding}/${page.lineEndings}`) ?? 0) + 1);
    if (!page.complete) incomplete++;
    for (const [label, entries] of page.fields) {
      const s = labels.get(label) ?? { pages: 0, entries: 0, maxEntries: 0, shapes: new Map() };
      s.pages++; s.entries += entries.length; s.maxEntries = Math.max(s.maxEntries, entries.length);
      for (const e of entries) for (const line of e.lines) {
        const k = shape(line);
        const v = s.shapes.get(k) ?? { n: 0, example: line };
        v.n++; s.shapes.set(k, v);
      }
      labels.set(label, s);
    }
    if (++done % 5000 === 0) console.log(`  ${done}`);
  }
}));

console.log(`\nencodings/line endings: ${JSON.stringify(Object.fromEntries(encodings))}; pages without end marker: ${incomplete}`);
const report = [...labels.entries()].sort((a, b) => b[1].pages - a[1].pages).map(([label, s]) => ({
  label, pages: s.pages, entries: s.entries, maxEntries: s.maxEntries, distinctShapes: s.shapes.size,
  topShapes: [...s.shapes.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 12).map(([k, v]) => ({ shape: k, n: v.n, example: v.example })),
}));
for (const r of report) {
  console.log(`\n${r.label}: ${r.pages} pages, ${r.entries} entries (max ${r.maxEntries}/page), ${r.distinctShapes} line shapes`);
  for (const t of r.topShapes.slice(0, 8)) console.log(`    ${String(t.n).padStart(6)}  ${t.shape.padEnd(45)}  e.g. ${t.example.slice(0, 70)}`);
}
if (outIdx > 0) writeFileSync(process.argv[outIdx + 1], JSON.stringify(report, null, 2));
