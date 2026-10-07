// Runs every test suite and fails unless all of them ran and passed.
// A skipped, todo, cancelled, or missing test counts as a failure: nothing
// is allowed to be silently skipped.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

const problems = [];
const run = (label, args) => {
  const r = spawnSync(process.execPath, args, { encoding: "utf8" });
  const out = `${r.stdout}\n${r.stderr}`;
  if (r.status !== 0) problems.push(`${label}: exited with code ${r.status}`);
  return out;
};

// 1. No skip/only markers may be committed in test files.
for (const dir of ["scripts/tests", "supabase/tests"]) {
  for (const f of readdirSync(dir)) {
    const src = readFileSync(`${dir}/${f}`, "utf8");
    if (/\b(test|it|describe)\.(skip|only|todo)\s*\(|\{\s*(skip|todo|only)\s*:/.test(src)) problems.push(`${dir}/${f}: contains skip/only/todo`);
  }
}

// 2. Database schema tests (PGlite).
const schema = run("schema tests", ["supabase/tests/schema.test.mjs"]);
const m = schema.match(/(\d+) passed, (\d+) failed/);
if (!m) problems.push("schema tests: no result line");
else {
  if (Number(m[2]) !== 0) problems.push(`schema tests: ${m[2]} failed`);
  if (Number(m[1]) === 0) problems.push("schema tests: 0 tests ran");
  console.log(`schema tests: ${m[1]} passed, ${m[2]} failed`);
}
for (const line of schema.split("\n")) if (/^\s+FAIL/.test(line)) console.log(line);

// 3. Fetcher tests (node:test).
const fetch = run("script tests (fetcher, parser, bulk)", ["--test", "--test-reporter=tap", "scripts/tests/*.test.mts"]);
const count = (k) => Number(fetch.match(new RegExp(`^# ${k} (\\d+)`, "m"))?.[1] ?? NaN);
const t = { tests: count("tests"), pass: count("pass"), fail: count("fail"), skipped: count("skipped"), todo: count("todo"), cancelled: count("cancelled") };
console.log("script tests (fetcher, parser, bulk):", JSON.stringify(t));
if (!(t.tests > 0)) problems.push("script tests (fetcher, parser, bulk): 0 tests ran");
if (t.pass !== t.tests) problems.push(`script tests (fetcher, parser, bulk): ${t.tests - t.pass} did not pass`);
for (const k of ["fail", "skipped", "todo", "cancelled"]) if (t[k] !== 0) problems.push(`script tests (fetcher, parser, bulk): ${t[k]} ${k}`);
for (const line of fetch.split("\n")) if (/^not ok/.test(line)) console.log(line);

if (problems.length) {
  console.error("\nTEST GATE FAILED:\n  " + problems.join("\n  "));
  process.exit(1);
}
console.log("\nAll tests ran and passed; none skipped.");
