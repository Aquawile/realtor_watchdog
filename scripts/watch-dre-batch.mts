// Live monitor for a DRE raw fetch run: GitHub Actions status + the batch's
// own record in Supabase (heartbeat, progress, DRE response-time ratio).
//
// Usage:
//   node --env-file=.env.local scripts/watch-dre-batch.mts --run <github run id>
//   node --env-file=.env.local scripts/watch-dre-batch.mts --batch <batch id>
// Options: --every <seconds> (default 15)
//
// Alerts when: the heartbeat is older than 45 s while running; DRE's window
// median is over the soft limit (DRE_SOFT_LIMIT_MS, default 2500 ms); GitHub reports the run finished while the batch still
// says running (runner died). Exits 0 only if the batch completed.

import { createClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const runId = arg("run");
const batchArg = arg("batch");
const every = Number(arg("every") ?? 15) * 1000;
const SOFT_LIMIT_MS = Number(process.env.DRE_SOFT_LIMIT_MS || 2500);
if (!runId && !batchArg) throw new Error("pass --run <github run id> or --batch <batch id>");

const db = createClient(process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const time = () => new Date().toTimeString().slice(0, 8);

type Batch = {
  id: number; status: string; stop_reason: string | null; planned_count: number | null; attempted: number; ok_count: number;
  not_found_count: number; incomplete_count: number; error_count: number; verify_failed_count: number;
  baseline_ms: number | null; window_median_ms: number | null; window_ratio: number | null; p90_ms: number | null;
  current_concurrency: number | null; max_concurrency_used: number | null; last_heartbeat_at: string;
};

function github(): { status: string; conclusion: string; jobs: string } | null {
  if (!runId) return null;
  try {
    const out = execFileSync("gh", ["run", "view", runId, "--json", "status,conclusion,jobs"], { encoding: "utf8" });
    const r = JSON.parse(out) as { status: string; conclusion: string; jobs: { name: string; status: string; conclusion: string }[] };
    return { status: r.status, conclusion: r.conclusion, jobs: r.jobs.map((j) => `${j.name}=${j.conclusion || j.status}`).join(", ") };
  } catch (e) {
    return { status: "unknown", conclusion: "", jobs: `gh error: ${e instanceof Error ? e.message.split("\n")[0] : e}` };
  }
}

async function findBatch(): Promise<Batch | null> {
  let query = db.from("raw_dre_fetch_batches").select("*");
  query = batchArg ? query.eq("id", Number(batchArg)) : query.like("runner", `%run ${runId} %`);
  const { data, error } = await query.order("id", { ascending: false }).limit(1);
  if (error) throw new Error(`read batch: ${JSON.stringify(error)}`);
  return (data?.[0] as Batch) ?? null;
}

let ghDoneWhileRunning = 0;
for (;;) {
  const gh = github();
  const b = await findBatch();
  const alerts: string[] = [];
  let line = `${time()} `;
  if (gh) line += `GitHub ${gh.status}${gh.conclusion ? "/" + gh.conclusion : ""} [${gh.jobs}] | `;
  if (!b) line += "batch: not started yet";
  else {
    const hbAge = Math.round((Date.now() - Date.parse(b.last_heartbeat_at)) / 1000);
    line += `batch ${b.id} ${b.status}: ${b.attempted}/${b.planned_count ?? "?"} ` +
      `(ok ${b.ok_count}, not found ${b.not_found_count}, incomplete ${b.incomplete_count}, errors ${b.error_count}, verify failed ${b.verify_failed_count}) ` +
      `| DRE baseline ${b.baseline_ms ?? "-"} ms, now ${b.window_median_ms ?? "-"} ms (${b.window_ratio ?? "-"}x) | parallel ${b.current_concurrency ?? "-"}/max ${b.max_concurrency_used ?? "-"} ` +
      `| heartbeat ${hbAge}s ago`;
    if (b.status === "running" && hbAge > 45) alerts.push(`heartbeat silent for ${hbAge}s`);
    if (b.window_median_ms !== null && b.window_median_ms > SOFT_LIMIT_MS) alerts.push(`DRE window median ${b.window_median_ms} ms is over the ${SOFT_LIMIT_MS} ms soft limit`);
    if (b.error_count || b.verify_failed_count) alerts.push(`${b.error_count} errors, ${b.verify_failed_count} verify failures`);
    if (gh?.status === "completed" && b.status === "running") {
      if (++ghDoneWhileRunning >= 3) alerts.push("GitHub run finished but batch still 'running': runner likely died (next run will mark it abandoned)");
    }
  }
  console.log(line + (alerts.length ? `\n         ⚠ ${alerts.join("; ")}` : ""));

  const batchDone = b && b.status !== "running";
  const ghDone = !gh || gh.status === "completed";
  if (batchDone && ghDone) {
    console.log(`\nFINAL: batch ${b.id} ${b.status.toUpperCase()}${b.stop_reason ? ` (${b.stop_reason})` : ""}` + (gh ? `; GitHub ${gh.conclusion}` : ""));
    process.exit(b.status === "completed" ? 0 : 1);
  }
  if (gh?.status === "completed" && !b) { console.log("\nFINAL: GitHub run finished without creating a batch (failed before fetching)"); process.exit(1); }
  if (ghDoneWhileRunning >= 3) process.exit(1);
  await sleep(every);
}
