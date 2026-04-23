/**
 * Aggregator — reads per-run summary.json files and emits
 * pages/leaderboard.json plus a minimal pages/index.html. SPEC §8.
 *
 * Ranks by *mean* final_money per orchestrator model, across all runs
 * for that model. Also reports standard deviation and sample size so
 * the leaderboard is honest about model-call nondeterminism (Ollama
 * and hosted endpoints both produce different trajectories from the
 * same seed). A single run isn't a confident score.
 *
 * Milestone 1 scope: local results/* only. The multi-branch fan-out
 * lands in the aggregator GitHub Action.
 */

import {
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  statSync,
} from "node:fs";
import path from "node:path";

import type { RunSummary } from "../harness/types";

interface AggregateEntry {
  rank: number;
  orchestrator_model: string;
  display_model: string;
  attribution: "public" | "anonymous";
  run_count: number;
  final_money_mean: number;
  final_money_std: number;
  final_money_min: number;
  final_money_max: number;
  completed_runs: number;
  failed_runs: number;
  latest_run_id: string;
  latest_artifact_url: string;
  branch: string;
  bitburner_commit: string;
}

interface Leaderboard {
  generated_at: string;
  bitburner_commit: string;
  entries: AggregateEntry[];
  /** Per-run rows so the UI can still show individual attempts. */
  raw_runs: Array<RunSummary & { artifact_url: string }>;
}

function readBranch(): string {
  try {
    const head = readFileSync(".git/HEAD", "utf8").trim();
    if (head.startsWith("ref: refs/heads/")) return head.slice("ref: refs/heads/".length);
    return head.slice(0, 7);
  } catch {
    return "unknown";
  }
}

function collectSummaries(resultsDir: string): Array<{ dir: string; summary: RunSummary }> {
  if (!existsSync(resultsDir)) return [];
  const out: Array<{ dir: string; summary: RunSummary }> = [];
  for (const entry of readdirSync(resultsDir)) {
    const full = path.join(resultsDir, entry);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    const summaryPath = path.join(full, "summary.json");
    if (!existsSync(summaryPath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(summaryPath, "utf8")) as RunSummary;
      out.push({ dir: entry, summary: parsed });
    } catch {
      /* skip */
    }
  }
  return out;
}

function stats(xs: number[]): { mean: number; std: number; min: number; max: number } {
  if (xs.length === 0) return { mean: 0, std: 0, min: 0, max: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.length > 1
    ? xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1)
    : 0;
  return {
    mean,
    std: Math.sqrt(variance),
    min: Math.min(...xs),
    max: Math.max(...xs),
  };
}

function build(): Leaderboard {
  const branch = readBranch();
  const summaries = collectSummaries("results");

  // Group by orchestrator_model.
  const groups = new Map<string, Array<{ dir: string; summary: RunSummary }>>();
  for (const s of summaries) {
    const key = s.summary.orchestrator_model;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }

  const aggregated: AggregateEntry[] = [];
  let anonCount = 0;
  for (const [model, runs] of groups) {
    const completed = runs.filter((r) => r.summary.status === "completed");
    const failed = runs.filter((r) => r.summary.status === "failed");
    // Mean is over completed runs only; a failed run's final_money is
    // the partial score at crash time and not comparable. Per SPEC §13
    // + CLAUDE.md "partial runs still count" — they're in raw_runs.
    const moneys = completed.map((r) => r.summary.final_money ?? 0);
    const s = stats(moneys);
    const latest = runs
      .slice()
      .sort((a, b) => (b.summary.start_time ?? "").localeCompare(a.summary.start_time ?? ""))[0];
    // attribution is per-run; if they disagree within a group, prefer
    // anonymous (most restrictive).
    const anyAnon = runs.some((r) => r.summary.attribution === "anonymous");
    const attribution: "public" | "anonymous" = anyAnon ? "anonymous" : "public";
    const display_model =
      attribution === "anonymous"
        ? `Submission ${String.fromCharCode("A".charCodeAt(0) + anonCount++)}`
        : model;

    aggregated.push({
      rank: 0, // set after sort
      orchestrator_model: model,
      display_model,
      attribution,
      run_count: runs.length,
      final_money_mean: Math.round(s.mean),
      final_money_std: Math.round(s.std),
      final_money_min: Math.round(s.min),
      final_money_max: Math.round(s.max),
      completed_runs: completed.length,
      failed_runs: failed.length,
      latest_run_id: latest?.summary.run_id ?? "",
      latest_artifact_url: latest ? `runs/${latest.summary.run_id}/` : "",
      branch,
      bitburner_commit: latest?.summary.bitburner_commit ?? "unknown",
    });
  }

  aggregated.sort((a, b) => b.final_money_mean - a.final_money_mean);
  aggregated.forEach((e, i) => (e.rank = i + 1));

  const bitburner_commit =
    summaries[0]?.summary.bitburner_commit ?? "unknown";

  const raw_runs = summaries
    .slice()
    .sort((a, b) =>
      (b.summary.start_time ?? "").localeCompare(a.summary.start_time ?? ""),
    )
    .map((r) => ({ ...r.summary, artifact_url: `runs/${r.summary.run_id}/` }));

  return {
    generated_at: new Date().toISOString(),
    bitburner_commit,
    entries: aggregated,
    raw_runs,
  };
}

function renderHtml(board: Leaderboard): string {
  const rows = board.entries
    .map(
      (e) => `<tr>
  <td>${e.rank}</td>
  <td>${escapeHtml(e.display_model)}</td>
  <td style="text-align:right">${e.final_money_mean.toLocaleString()}</td>
  <td style="text-align:right">±${e.final_money_std.toLocaleString()}</td>
  <td style="text-align:right">${e.completed_runs}/${e.run_count}</td>
  <td><a href="${escapeHtml(e.latest_artifact_url)}">latest</a></td>
</tr>`,
    )
    .join("\n");

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Benchburner Leaderboard</title>
<style>
body { font-family: system-ui, sans-serif; max-width: 960px; margin: 2rem auto; padding: 0 1rem; }
table { border-collapse: collapse; width: 100%; }
th, td { padding: 0.5rem 1rem; border-bottom: 1px solid #ddd; }
th { text-align: left; background: #f6f6f6; }
small { color: #777; }
.meta { color: #555; font-size: 0.85em; }
</style>
</head>
<body>
<h1>Benchburner Leaderboard</h1>
<p class="meta">Generated ${escapeHtml(board.generated_at)} · bitburner <code>${escapeHtml(board.bitburner_commit.slice(0, 8))}</code>
· ranked by mean final money across completed runs per orchestrator.
The ± column is sample standard deviation; completed/total reflects
how many runs contributed to the mean.</p>
<table>
<thead><tr>
  <th>Rank</th><th>Orchestrator</th>
  <th style="text-align:right">Mean final money</th>
  <th style="text-align:right">±</th>
  <th style="text-align:right">Completed / total</th>
  <th>Latest</th>
</tr></thead>
<tbody>
${rows}
</tbody>
</table>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function main(): void {
  mkdirSync("pages", { recursive: true });
  const board = build();
  writeFileSync("pages/leaderboard.json", JSON.stringify(board, null, 2) + "\n");
  writeFileSync("pages/index.html", renderHtml(board));
  console.log(
    `Wrote leaderboard: ${board.entries.length} orchestrators, ${board.raw_runs.length} runs`,
  );
}

main();
