// Tests for the DRE raw fetcher core against simulated DRE and Supabase
// behavior, on a virtual clock: simulated time advances only when every task
// is waiting on a timer, so a scripted 1,400 ms response always measures
// exactly 1,400 ms regardless of machine load (no real waiting either).
import assert from "node:assert/strict";
import { test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  DEFAULTS, runFetch, sha256, verifyStored,
  type FetchDeps, type PageReceipt, type PageResponse, type Settings,
} from "../lib/raw-fetch-core.mts";

let virtualNow = 0;
let timerSeq = 0;
let driving = false;
const timers: { at: number; seq: number; resolve: () => void }[] = [];
// setImmediate runs only after all pending promise callbacks have drained,
// i.e. when every task is blocked on a timer; then fire the earliest one.
function step() {
  const next = timers.shift();
  if (!next) { driving = false; return; }
  virtualNow = Math.max(virtualNow, next.at);
  next.resolve();
  setImmediate(step);
}
const now = () => virtualNow;
const sleep = (ms: number) => new Promise<void>((resolve) => {
  timers.push({ at: virtualNow + Math.max(0, ms), seq: timerSeq++, resolve });
  timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
  if (!driving) { driving = true; setImmediate(step); }
});
const enc = (s: string) => new TextEncoder().encode(s);

const OK_PAGE = (lic: string) => enc(`<html>License ID: ${lic}<br/>\r\n>>>> Public information request complete <<<<</html>`);
const NOT_FOUND_PAGE = enc("<html>No matching public record was found for License ID</html>");
const TRUNCATED_PAGE = enc("<html><table><tr><td>License Type:");

type Scenario = (license: string, attempt: number, index: number) => { latency: number; status?: number; body?: Uint8Array; throws?: string };

function harness(scenario: Scenario, opts: {
  storeFailures?: (path: string, attempt: number) => boolean;
  corrupt?: (path: string) => boolean;            // storage silently keeps different bytes
  stop?: () => string | null;
} = {}) {
  const files = new Map<string, Uint8Array>();
  const receipts: PageReceipt[] = [];
  const logs: string[] = [];
  const progress: import("../lib/raw-fetch-core.mts").Progress[] = [];
  const attempts = new Map<string, number>();
  const storeAttempts = new Map<string, number>();
  let started = 0;
  const deps: FetchDeps = {
    async fetchPage(url): Promise<PageResponse> {
      const lic = url.slice(-8);
      const n = (attempts.get(lic) ?? 0) + 1;
      attempts.set(lic, n);
      const s = scenario(lic, n, n === 1 ? started++ : -1);
      await sleep(s.latency);
      if (s.throws) throw new Error(s.throws);
      return { status: s.status ?? 200, headers: { "content-type": "text/html" }, bytes: s.body ?? OK_PAGE(lic) };
    },
    async storePage(path, gz) {
      const n = (storeAttempts.get(path) ?? 0) + 1;
      storeAttempts.set(path, n);
      if (opts.storeFailures?.(path, n)) throw new Error("simulated storage outage");
      files.set(path, opts.corrupt?.(path) ? gzipSync(enc("tampered")) : gz);
    },
    async downloadStored(path) {
      const f = files.get(path);
      if (!f) throw new Error("object not found");
      return f;
    },
    async logPage(r) { receipts.push(r); },
    async progress(p) { progress.push(p); },
    now, sleep, isoNow: () => new Date().toISOString() + Math.random().toString(36).slice(2, 6), log: (m) => logs.push(m),
    externalStop: opts.stop ?? (() => null),
  };
  return { deps, files, receipts, logs, attempts, progress };
}

const licenses = (n: number) => Array.from({ length: n }, (_, i) => String(10_000_000 + i));
const S = (o: Partial<Settings> = {}): Settings => ({ ...DEFAULTS, ...o });

test("completes a batch and stores every page byte-for-byte", async () => {
  const h = harness(() => ({ latency: 1000 }));
  const r = await runFetch(licenses(30), h.deps, S());
  assert.equal(r.status, "completed");
  assert.equal(r.stats.ok, 30);
  assert.equal(h.receipts.length, 30);
  assert.equal(h.files.size, 30);
  for (const rec of h.receipts) {
    const raw = gunzipSync(h.files.get(rec.storage_path!)!);
    assert.equal(sha256(raw), rec.sha256_raw);
    assert.deepEqual(new Uint8Array(raw), OK_PAGE(rec.license_number));
    assert.ok(rec.verified_at, "verified inline");
    assert.equal(rec.outcome, "ok");
  }
});

test("ramps up parallel requests while DRE's response time stays normal", async () => {
  const h = harness(() => ({ latency: 1000 }));
  const r = await runFetch(licenses(80), h.deps, S({ maxConcurrency: 8 }));
  assert.equal(r.status, "completed");
  assert.ok(r.maxUsed > DEFAULTS.startConcurrency, `max parallel ${r.maxUsed}`);
  assert.ok(r.maxUsed <= 8);
});

test("normal variation (batch 6 pattern, 1.1-1.8 s) never triggers the guardrails", async () => {
  const pattern = [1100, 1300, 1800, 1200, 1500, 1400, 1700, 1250, 1600, 1350];
  const h = harness((_l, _a, i) => ({ latency: pattern[Math.abs(i) % pattern.length] }));
  const r = await runFetch(licenses(150), h.deps, S());
  assert.equal(r.status, "completed");
  assert.ok(!h.logs.some((l) => /SLOW/.test(l)), h.logs.join("\n"));
  assert.equal(r.maxUsed, DEFAULTS.maxConcurrency);
});

test("soft limit: a brief spike above 2,500 ms halves parallel requests, then it recovers", async () => {
  const h = harness((_l, _a, i) => ({ latency: i >= 40 && i < 50 ? 3000 : 1000 }));
  const r = await runFetch(licenses(150), h.deps, S());
  assert.equal(r.status, "completed", h.logs.join("\n"));
  const slow = h.logs.find((l) => /^SLOW: window median 3\d{3} ms/.test(l));
  assert.ok(slow, h.logs.join("\n"));
  const [, before, after] = slow!.match(/concurrency (\d+) -> (\d+)/)!;
  assert.equal(Number(after), Math.floor(Number(before) / 2));
});

test("HARD STOP: self-terminates if still above the soft limit after backing off", async () => {
  const h = harness((_l, _a, i) => ({ latency: i < 20 ? 1000 : 3000 }));
  const r = await runFetch(licenses(300), h.deps, S());
  assert.equal(r.status, "stopped");
  assert.match(r.stopReason!, /^hard stop: DRE still slow after backing off/);
  assert.equal(h.logs.filter((l) => /^SLOW/.test(l)).length, 1, "backed off exactly once before stopping");
  assert.ok(r.stats.attempted < 100, `kept going: ${r.stats.attempted}`);
});

test("hard limit: above 4,000 ms drops to 1 request and pauses; hard stop if still over", async () => {
  const h = harness((_l, _a, i) => ({ latency: i < 20 ? 1000 : 5000 }));
  const t0 = now();
  const r = await runFetch(licenses(300), h.deps, S());
  assert.equal(r.status, "stopped");
  assert.match(r.stopReason!, /^hard stop/);
  const vs = h.logs.find((l) => /^VERY SLOW: window median 5\d{3} ms/.test(l));
  assert.ok(vs && /concurrency \d+ -> 1, pausing 60s/.test(vs), h.logs.join("\n"));
  assert.ok(now() - t0 > 60_000, "the 60 s pause actually happened");
});

test("a per-request hard timeout is enforced", async () => {
  let seen = 0;
  const h = harness(() => ({ latency: 1000 }));
  const fetchPage = h.deps.fetchPage;
  h.deps.fetchPage = (url, timeoutMs) => { seen = timeoutMs; return fetchPage(url, timeoutMs); };
  await runFetch(licenses(3), h.deps, S());
  assert.equal(seen, 15_000);
});

test("batch 7 pattern: a slow start doesn't blind the guardrail to a later slowdown", async () => {
  // DRE at 5.6 s for the first 40 s (as seen in batch 7), then normal
  // (~1.4 s), then a real slowdown to ~3 s. Old logic took 5.6 s as the
  // baseline and would have ignored anything under ~7.3 s.
  const t0 = now();
  const h = harness(() => {
    const t = now() - t0;
    return { latency: t < 40_000 ? 5600 : t < 200_000 ? 1400 : 3000 };
  });
  const r = await runFetch(licenses(3000), h.deps, S());
  assert.ok(h.logs.some((l) => /^VERY SLOW: window median 5\d{3} ms/.test(l)), "slow start detected");
  assert.equal(r.status, "stopped", h.logs.join("\n"));
  assert.match(r.stopReason!, /^hard stop: DRE still slow after backing off 1x: window median 3\d{3} ms/);
  assert.ok(r.baseline! >= 1300 && r.baseline! <= 1600, `baseline ${r.baseline} reflects normal, not the slow start`);
  assert.ok(r.stats.ok > 300, `fetched through the normal period: ${r.stats.ok}`);
});

test("stops immediately on a possible block (403/429/503) without retrying", async () => {
  for (const code of [403, 429, 503]) {
    const h = harness((_l, _a, i) => (i === 15 ? { latency: 1000, status: code, body: enc("blocked") } : { latency: 1000 }));
    const r = await runFetch(licenses(100), h.deps, S());
    assert.equal(r.status, "stopped", `HTTP ${code}`);
    assert.match(r.stopReason!, new RegExp(`HTTP ${code}`));
    const blocked = h.receipts.find((x) => x.http_status === code)!;
    assert.equal(blocked.attempts, 1);
    assert.equal(blocked.storage_path, null);
    assert.ok(r.stats.attempted < 30, `kept going after block: ${r.stats.attempted}`);
  }
});

test("retries temporary network errors and succeeds", async () => {
  const h = harness((_l, attempt, ) => (attempt === 1 ? { latency: 200, throws: "ECONNRESET" } : { latency: 1000 }));
  const r = await runFetch(licenses(12), h.deps, S());
  assert.equal(r.status, "completed");
  assert.equal(r.stats.ok, 12);
  assert.ok(h.receipts.every((x) => x.attempts === 2 && x.outcome === "ok"));
});

test("records a network failure after all retries, and stops after 5 in a row", async () => {
  const h = harness(() => ({ latency: 100, throws: "TimeoutError" }));
  const r = await runFetch(licenses(50), h.deps, S());
  assert.equal(r.status, "stopped");
  assert.match(r.stopReason!, /5 errors in a row/);
  assert.ok(h.receipts.every((x) => x.outcome === "network_error" && x.attempts === 3 && x.storage_path === null));
});

test("stops when more than 2% of attempts fail", async () => {
  // Every 20th page fails permanently: never 5 in a row, but the rate exceeds 2%.
  const h = harness((l) => (Number(l) % 20 === 0 || Number(l) % 20 === 1 ? { latency: 100, status: 500, body: enc("err") } : { latency: 1000 }));
  const r = await runFetch(licenses(300), h.deps, S());
  assert.equal(r.status, "stopped");
  assert.match(r.stopReason!, /error rate/);
});

test("stores and flags incomplete pages and not-found pages", async () => {
  const h = harness((l) => (l.endsWith("3") ? { latency: 1000, body: TRUNCATED_PAGE } : l.endsWith("7") ? { latency: 1000, body: NOT_FOUND_PAGE } : { latency: 1000 }));
  const r = await runFetch(licenses(20), h.deps, S());
  assert.equal(r.status, "completed");
  assert.equal(r.stats.incomplete, 2);
  assert.equal(r.stats.not_found, 2);
  assert.ok(h.receipts.filter((x) => x.outcome === "incomplete").every((x) => x.storage_path));
});

test("retries a temporary storage outage", async () => {
  const h = harness(() => ({ latency: 500 }), { storeFailures: (_p, n) => n === 1 });
  const r = await runFetch(licenses(10), h.deps, S());
  assert.equal(r.status, "completed");
  assert.equal(h.files.size, 10);
});

test("fails loudly (never silently) if storage stays down", async () => {
  const h = harness(() => ({ latency: 500 }), { storeFailures: () => true });
  const r = await runFetch(licenses(10), h.deps, S());
  assert.equal(r.status, "failed");
  assert.match(r.stopReason!, /upload .* failed after 3 attempts/);
});

test("stops cleanly when cancelled (SIGTERM) and records what it did", async () => {
  let n = 0;
  const h = harness(() => ({ latency: 1000 }), { stop: () => (++n > 30 ? "received SIGTERM" : null) });
  const r = await runFetch(licenses(500), h.deps, S());
  assert.equal(r.status, "stopped");
  assert.equal(r.stopReason, "received SIGTERM");
  assert.equal(h.receipts.length, r.stats.attempted);
  assert.ok(r.stats.attempted < 500);
});

test("stops at the time limit", async () => {
  const h = harness(() => ({ latency: 1000 }));
  const r = await runFetch(licenses(10_000), h.deps, S({ maxMinutes: 0.5 }));
  assert.equal(r.status, "stopped");
  assert.match(r.stopReason!, /time limit/);
});

test("catches a stored file that doesn't match what DRE sent, and keeps going", async () => {
  const h = harness(() => ({ latency: 1000 }), { corrupt: (p) => p.includes("/10000004/") });
  const r = await runFetch(licenses(20), h.deps, S());
  assert.equal(r.status, "completed");
  assert.equal(r.stats.verify_failed, 1);
  assert.equal(r.stats.ok, 19);
  const bad = h.receipts.find((x) => x.license_number === "10000004")!;
  assert.equal(bad.outcome, "verify_failed");
  assert.equal(bad.verified_at, null);
  assert.match(bad.error!, /verification: (size|checksum)/);
});

test("reports DRE's live response-time ratio for monitoring", async () => {
  const h = harness(() => ({ latency: 1000 }));
  await runFetch(licenses(60), h.deps, S({ progressEveryMs: 1 }));
  const withRatio = h.progress.filter((p) => p.window_ratio !== null);
  assert.ok(withRatio.length > 0);
  for (const p of withRatio) assert.ok(p.window_ratio! > 0.7 && p.window_ratio! < 1.3, `ratio ${p.window_ratio}`);
  assert.ok(withRatio.every((p) => p.window_median_ms! > 700 && p.window_median_ms! < 1300));
});

test("verifies existing files in parallel and catches corrupt or missing ones", async () => {
  const good = enc("page A"), bad = enc("page B");
  const store = new Map<string, Uint8Array>([["a", gzipSync(good)], ["b", gzipSync(enc("page B tampered"))]]);
  const many = Array.from({ length: 40 }, (_, i) => ({ id: 100 + i, storage_path: "a", sha256_raw: sha256(good), byte_size: good.length }));
  let active = 0, peak = 0;
  const download = async (p: string) => {
    active++; peak = Math.max(peak, active);
    await sleep(200);
    active--;
    const f = store.get(p);
    if (!f) throw new Error("not found");
    return f;
  };
  const v = await verifyStored([
    ...many,
    { id: 2, storage_path: "b", sha256_raw: sha256(bad), byte_size: bad.length },
    { id: 3, storage_path: "missing", sha256_raw: sha256(good), byte_size: good.length },
  ], download, sleep, 10);
  assert.equal(v.verifiedIds.length, 40);
  assert.deepEqual(v.failed.map((f) => f.id).sort(), [2, 3]);
  assert.ok(peak > 1 && peak <= 10, `parallel downloads peaked at ${peak}`);
});
