// Core of the DRE raw page fetcher, with all I/O injected so it can be tested
// against simulated DRE/Supabase failures. See scripts/fetch-dre-pages.mts.

import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

export type PageResponse = { status: number; headers: Record<string, string>; bytes: Uint8Array };
export type Outcome = "ok" | "not_found" | "incomplete" | "http_error" | "network_error" | "verify_failed";

export type PageReceipt = {
  license_number: string; requested_url: string; duration_ms: number; attempts: number;
  http_status: number | null; response_headers: Record<string, string> | null; byte_size: number | null;
  sha256_raw: string | null; storage_path: string | null; outcome: Outcome; error: string | null;
  verified_at: string | null;
};

export type Stats = { attempted: number; ok: number; not_found: number; incomplete: number; errors: number; verify_failed: number };

export type Progress = Stats & { baseline_ms: number | null; median_ms: number | null; p90_ms: number | null;
  current_concurrency: number; max_concurrency_used: number;
  window_median_ms: number | null; window_ratio: number | null }; // latest pacing window vs baseline

export interface FetchDeps {
  fetchPage(url: string, timeoutMs: number): Promise<PageResponse>; // throws on network failure
  storePage(path: string, gzipped: Uint8Array): Promise<void>;
  downloadStored(path: string): Promise<Uint8Array>; // read back for verification
  logPage(receipt: PageReceipt): Promise<void>;
  progress(p: Progress): Promise<void>;
  now(): number;                    // ms
  sleep(ms: number): Promise<void>;
  isoNow(): string;
  log(msg: string): void;
  externalStop(): string | null;    // e.g. SIGTERM received
}

export const DEFAULTS = {
  lookupUrl: "https://www2.dre.ca.gov/PublicASP/pplinfo.asp?License_id=",
  requestTimeoutMs: 15_000,    // hard per-request limit: aborted (then retried) past this
  startConcurrency: 2,
  maxConcurrency: 8,
  window: 10,                  // responses per pacing decision
  // Hard millisecond guardrails on each window's median DRE response time:
  // above softLimitMs -> halve concurrency; above hardLimitMs -> drop to 1 and
  // pause. (DRE normally answers in ~1.1-1.5 s, p90 ~1.9 s.)
  softLimitMs: 2_500,
  hardLimitMs: 4_000,
  verySlowPauseMs: 60_000,
  // Hard stop: this many slow windows in a row (i.e. still slow after backing
  // off) and the fetcher terminates itself.
  slowStreakStop: 2,
  blockStatuses: [403, 429, 503],
  maxConsecutiveErrors: 5,
  maxErrorRate: 0.02,          // after 50 attempts
  retryDelaysMs: [5_000, 15_000],
  storageRetries: 3,
  maxMinutes: 300,
  progressEveryMs: 15_000,
};
export type Settings = typeof DEFAULTS;

export class GuardrailStop extends Error {}

export const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
export const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
export const p90 = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.9))] : 0; };

// Classify a 200 response by DRE's own end-of-page markers (ASCII).
export function classify(bytes: Uint8Array): "ok" | "not_found" | "incomplete" {
  const text = new TextDecoder("latin1").decode(bytes);
  if (/Public information request complete/i.test(text)) return "ok";
  if (/No matching public record was found/i.test(text)) return "not_found";
  return "incomplete";
}

// Retry a Supabase-side operation; throws after the last attempt.
export async function withRetry<T>(what: string, fn: () => Promise<T>, attempts: number, sleep: (ms: number) => Promise<void>): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts) throw new Error(`${what} failed after ${attempts} attempts: ${e instanceof Error ? e.message : String(e)}`);
      await sleep(2_000 * i);
    }
  }
}

export type FetchResult = {
  status: "completed" | "stopped" | "failed"; stopReason: string | null;
  stats: Stats; baseline: number | null; maxUsed: number; durations: number[];
};

export async function runFetch(todo: string[], deps: FetchDeps, s: Settings = DEFAULTS): Promise<FetchResult> {
  const startedAt = deps.now();
  const stats: Stats = { attempted: 0, ok: 0, not_found: 0, incomplete: 0, errors: 0, verify_failed: 0 };
  let windowMedian: number | null = null, windowRatio: number | null = null;
  const durations: number[] = [];
  let windowDurations: number[] = [];
  const normalWindows: number[] = []; // medians of windows within limits
  let baseline: number | null = null;
  let concurrency = Math.min(s.startConcurrency, s.maxConcurrency);
  let maxUsed = concurrency;
  let stopReason: string | null = null;
  let consecutiveErrors = 0;
  let slowStreak = 0;
  // Pacing generation: bumped on every back-off, so the next window only
  // measures requests launched after the back-off (not ones already in flight).
  let gen = 0;
  let pausedUntil = 0;
  let lastProgress = deps.now();
  const blocks = new Set(s.blockStatuses);

  const progress = () => deps.progress({
    ...stats, baseline_ms: baseline, median_ms: durations.length ? Math.round(median(durations)) : null,
    p90_ms: durations.length ? Math.round(p90(durations)) : null, current_concurrency: concurrency, max_concurrency_used: maxUsed,
    window_median_ms: windowMedian, window_ratio: windowRatio,
  });

  const fetchOne = async (license: string, launchGen: number) => {
    const url = s.lookupUrl + license;
    let outcome: Outcome = "network_error";
    let res: PageResponse | null = null;
    let error: string | null = null, ms = 0, attempts = 0;
    for (const delay of [0, ...s.retryDelaysMs]) {
      if (delay) await deps.sleep(delay);
      attempts++;
      const t = deps.now();
      try {
        res = await deps.fetchPage(url, s.requestTimeoutMs);
        ms = Math.round(deps.now() - t);
        if (blocks.has(res.status)) { outcome = "http_error"; error = `HTTP ${res.status} (possible block)`; break; }
        if (res.status !== 200) { outcome = "http_error"; error = `HTTP ${res.status}`; continue; }
        outcome = classify(res.bytes);
        error = null;
        break;
      } catch (e) {
        ms = Math.round(deps.now() - t);
        res = null;
        outcome = "network_error";
        error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      }
    }

    const stored = outcome === "ok" || outcome === "not_found" || outcome === "incomplete";
    const path = stored ? `pages/${license}/${deps.isoNow()}.html.gz` : null;
    const rawSha = stored ? sha256(res!.bytes) : null;
    let verifiedAt: string | null = null;
    if (stored) {
      const gz = gzipSync(res!.bytes, { level: 9 });
      await withRetry(`upload ${license}`, () => deps.storePage(path!, gz), s.storageRetries, deps.sleep);
      // Verify inline: read the stored file back and compare with what DRE sent.
      const problem = await checkStored(path!, rawSha!, res!.bytes.length, deps.downloadStored, s.storageRetries, deps.sleep);
      if (problem) { outcome = "verify_failed"; error = `verification: ${problem}`; }
      else verifiedAt = deps.isoNow();
    }
    await withRetry(`log ${license}`, () => deps.logPage({
      license_number: license, requested_url: url, duration_ms: ms, attempts,
      http_status: res?.status ?? null, response_headers: res?.headers ?? null, byte_size: res?.bytes.length ?? null,
      sha256_raw: rawSha, storage_path: path, outcome, error, verified_at: verifiedAt,
    }), s.storageRetries, deps.sleep);

    stats.attempted++;
    if (outcome === "ok") stats.ok++;
    else if (outcome === "not_found") stats.not_found++;
    else if (outcome === "incomplete") stats.incomplete++;
    else if (outcome === "verify_failed") stats.verify_failed++;
    else stats.errors++;

    if (res && blocks.has(res.status)) throw new GuardrailStop(`DRE returned HTTP ${res.status} for ${license}: possible rate limit or block`);
    if (outcome === "http_error" || outcome === "network_error") {
      if (++consecutiveErrors >= s.maxConsecutiveErrors) throw new GuardrailStop(`${consecutiveErrors} errors in a row (last: ${error})`);
    } else consecutiveErrors = 0;
    if (stats.attempted >= 50 && stats.errors / stats.attempted > s.maxErrorRate) {
      throw new GuardrailStop(`error rate ${(100 * stats.errors / stats.attempted).toFixed(1)}% exceeds ${s.maxErrorRate * 100}%`);
    }

    // Pacing: only complete responses count toward DRE's response time.
    if (outcome !== "ok" && outcome !== "not_found") return;
    durations.push(ms);
    if (launchGen !== gen) return; // launched before the last back-off
    windowDurations.push(ms);
    if (windowDurations.length < s.window) return;
    const m = Math.round(median(windowDurations));
    windowDurations = [];

    // Decisions use absolute milliseconds only. The baseline (median of the
    // windows that were within limits) is reported for monitoring, never used
    // to decide, so a slow start can't blind the guardrail.
    const verySlow = m > s.hardLimitMs;
    const slow = verySlow || m > s.softLimitMs;
    if (!slow) {
      normalWindows.push(m);
      const b = Math.round(median(normalWindows));
      if (baseline === null) deps.log(`baseline response time: ${b} ms`);
      baseline = b;
    }
    windowMedian = m;
    windowRatio = baseline ? Math.round((m / baseline) * 100) / 100 : null;
    const why = `window median ${m} ms (soft limit ${s.softLimitMs} ms, hard limit ${s.hardLimitMs} ms` +
      (baseline ? `, normal ~${baseline} ms` : "") + ")";
    const before = concurrency;

    if (slow) {
      // Hard stop: still slow in the first window measured after backing off.
      if (++slowStreak >= s.slowStreakStop) {
        throw new GuardrailStop(`hard stop: DRE still slow after backing off ${slowStreak - 1}x: ${why}`);
      }
      if (verySlow) {
        concurrency = 1;
        pausedUntil = deps.now() + s.verySlowPauseMs;
      } else {
        concurrency = Math.max(1, Math.floor(concurrency / 2));
      }
      gen++; // measure only requests launched from now on
      deps.log(`${verySlow ? "VERY SLOW" : "SLOW"}: ${why}: concurrency ${before} -> ${concurrency}` +
        (verySlow ? `, pausing ${s.verySlowPauseMs / 1000}s` : "") + `; hard stop if the next window is still slow`);
      return;
    }

    slowStreak = 0;
    concurrency = Math.min(s.maxConcurrency, concurrency + 1);
    maxUsed = Math.max(maxUsed, concurrency);
    if (concurrency !== before) deps.log(`${why}: concurrency ${before} -> ${concurrency}`);
  };

  // Worker pool whose size follows `concurrency`.
  const queue = [...todo];
  const inFlight = new Set<Promise<void>>();
  let fatal: unknown = null;
  while ((queue.length || inFlight.size) && !fatal) {
    stopReason ??= deps.externalStop();
    if (deps.now() - startedAt > s.maxMinutes * 60_000) stopReason ??= `reached time limit of ${s.maxMinutes} min`;
    const canLaunch = !stopReason && deps.now() >= pausedUntil;
    while (canLaunch && queue.length && inFlight.size < concurrency) {
      const p: Promise<void> = fetchOne(queue.shift()!, gen)
        .catch((e) => { if (e instanceof GuardrailStop) stopReason ??= e.message; else fatal ??= e; })
        .finally(() => { inFlight.delete(p); });
      inFlight.add(p);
    }
    if (deps.now() - lastProgress >= s.progressEveryMs) {
      lastProgress = deps.now();
      await progress().catch((e) => deps.log(`progress update failed: ${e}`));
    }
    if (inFlight.size) await Promise.race(inFlight);
    else if (stopReason) break;
    else await deps.sleep(250);
  }
  await Promise.allSettled(inFlight);
  await progress().catch((e) => deps.log(`progress update failed: ${e}`));

  if (fatal) {
    return { status: "failed", stopReason: fatal instanceof Error ? fatal.message : String(fatal), stats, baseline, maxUsed, durations };
  }
  return { status: stopReason ? "stopped" : "completed", stopReason, stats, baseline, maxUsed, durations };
}

// ---- Verification: prove every stored file is byte-identical to what DRE sent.
// Returns null if the stored file matches, otherwise the reason.
export async function checkStored(path: string, sha: string, size: number, download: (p: string) => Promise<Uint8Array>,
  retries: number, sleep: (ms: number) => Promise<void>): Promise<string | null> {
  try {
    const raw = gunzipSync(await withRetry(`download ${path}`, () => download(path), retries, sleep));
    if (raw.length !== size) return `size ${raw.length} != ${size}`;
    if (sha256(raw) !== sha) return "checksum mismatch";
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export type StoredReceipt = { id: number; storage_path: string; sha256_raw: string; byte_size: number };

// Verify many stored files in parallel (our own Storage, not DRE).
export async function verifyStored(receipts: StoredReceipt[], download: (p: string) => Promise<Uint8Array>,
  sleep: (ms: number) => Promise<void>, concurrency = 10, retries = 3) {
  const verifiedIds: number[] = [];
  const failed: { id: number; reason: string }[] = [];
  const queue = [...receipts];
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      const problem = await checkStored(r.storage_path, r.sha256_raw, r.byte_size, download, retries, sleep);
      if (problem) failed.push({ id: r.id, reason: problem });
      else verifiedIds.push(r.id);
    }
  }));
  return { verifiedIds, failed };
}
