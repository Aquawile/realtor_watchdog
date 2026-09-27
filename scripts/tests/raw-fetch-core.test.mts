// Tests for the DRE raw fetcher core against simulated DRE and Supabase
// behavior. Time is scaled: 1 simulated second = 25 real ms (coarser scaling
// lets timer jitter distort measured response times).
import assert from "node:assert/strict";
import { test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  DEFAULTS, runFetch, sha256, verifyStored,
  type FetchDeps, type PageReceipt, type PageResponse, type Settings,
} from "../lib/raw-fetch-core.mts";

const SCALE = 40;
const now = () => performance.now() * SCALE;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms / SCALE));
const enc = (s: string) => new TextEncoder().encode(s);

const OK_PAGE = (lic: string) => enc(`<html>License ID: ${lic}<br/>\r\n>>>> Public information request complete <<<<</html>`);
const NOT_FOUND_PAGE = enc("<html>No matching public record was found for License ID</html>");
const TRUNCATED_PAGE = enc("<html><table><tr><td>License Type:");

type Scenario = (license: string, attempt: number, index: number) => { latency: number; status?: number; body?: Uint8Array; throws?: string };

function harness(scenario: Scenario, opts: { storeFailures?: (path: string, attempt: number) => boolean; stop?: () => string | null } = {}) {
  const files = new Map<string, Uint8Array>();
  const receipts: PageReceipt[] = [];
  const logs: string[] = [];
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
      files.set(path, gz);
    },
    async logPage(r) { receipts.push(r); },
    async progress() {},
    now, sleep, isoNow: () => new Date().toISOString() + Math.random().toString(36).slice(2, 6), log: (m) => logs.push(m),
    externalStop: opts.stop ?? (() => null),
  };
  return { deps, files, receipts, logs, attempts };
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
  }
});

test("ramps up parallel requests while DRE's response time stays normal", async () => {
  const h = harness(() => ({ latency: 1000 }));
  const r = await runFetch(licenses(80), h.deps, S({ maxConcurrency: 8 }));
  assert.equal(r.status, "completed");
  assert.ok(r.maxUsed > DEFAULTS.startConcurrency, `max parallel ${r.maxUsed}`);
  assert.ok(r.maxUsed <= 8);
});

test("halves parallel requests when DRE slows down more than 30%", async () => {
  const h = harness((_l, _a, i) => ({ latency: i < 40 ? 1000 : 1500 }));
  const r = await runFetch(licenses(80), h.deps, S());
  assert.equal(r.status, "completed");
  const drops = h.logs.map((l) => l.match(/\((\d+\.\d+)x baseline\): concurrency (\d+) -> (\d+)/)).filter(Boolean)
    .filter((m) => Number(m![1]) > 1.3 && Number(m![1]) <= 2 && Number(m![3]) < Number(m![2]));
  assert.ok(drops.length > 0, h.logs.join("\n"));
});

test("pauses and then stops if DRE stays more than 2x slower", async () => {
  const h = harness((_l, _a, i) => ({ latency: i < 20 ? 1000 : 3000 }));
  const r = await runFetch(licenses(200), h.deps, S());
  assert.equal(r.status, "stopped");
  assert.match(r.stopReason!, /slower than baseline/);
  assert.ok(h.logs.some((l) => /pausing 60s/.test(l)));
  assert.ok(r.stats.attempted < 200);
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

test("verification passes identical files and catches corrupt or missing ones", async () => {
  const good = enc("page A"), bad = enc("page B");
  const store = new Map<string, Uint8Array>([["a", gzipSync(good)], ["b", gzipSync(enc("page B tampered"))]]);
  const verified: number[] = [], failed: [number, string][] = [];
  const v = await verifyStored([
    { id: 1, storage_path: "a", sha256_raw: sha256(good), byte_size: good.length },
    { id: 2, storage_path: "b", sha256_raw: sha256(bad), byte_size: bad.length },
    { id: 3, storage_path: "missing", sha256_raw: sha256(good), byte_size: good.length },
  ], {
    download: async (p) => { const f = store.get(p); if (!f) throw new Error("not found"); return f; },
    markVerified: async (id) => { verified.push(id); },
    markFailed: async (id, reason) => { failed.push([id, reason]); },
    sleep,
  });
  assert.deepEqual(v, { verified: 1, failed: 2 });
  assert.deepEqual(verified, [1]);
  assert.deepEqual(failed.map(([id]) => id), [2, 3]);
});
