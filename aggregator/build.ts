/**
 * Aggregator — reads per-run summary.json files and emits
 * pages/leaderboard.json plus a minimal pages/index.html. SPEC §8.
 *
 * Milestone 1 scope: local results/* only. The multi-branch fan-out
 * (checking out every orchestrator/* branch, harvesting their
 * summaries) is deferred until we have more than one orchestrator
 * branch to aggregate over. The shape we produce here is already
 * SPEC §8-compatible so the frontend design (Claude Design task) can
 * consume it unchanged once fan-out lands.
 */

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";

import type { RunSummary } from "../harness/types";

interface LeaderboardEntry {
  rank: number;
  orchestrator_model: string;
  attribution: "public" | "anonymous";
  final_money: number;
  bitnodes_completed: number;
  augments_installed: number;
  status: string;
  run_id: string;
  branch: string;
  artifact_url: string;
}

interface Leaderboard {
  generated_at: string;
  bitburner_commit: string;
  entries: LeaderboardEntry[];
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
      continue;
    }
  }
  return out;
}

function anonymize(entries: LeaderboardEntry[]): LeaderboardEntry[] {
  let anonCount = 0;
  return entries.map((e) => {
    if (e.attribution === "anonymous") {
      const label = String.fromCharCode("A".charCodeAt(0) + anonCount);
      anonCount += 1;
      return { ...e, orchestrator_model: `Submission ${label}` };
    }
    return e;
  });
}

function build(): Leaderboard {
  const branch = readBranch();
  const summaries = collectSummaries("results");

  const ranked = summaries
    .slice()
    .sort((a, b) => {
      // Completed runs rank above failed; then by final_money desc.
      const aDone = a.summary.status === "completed" ? 1 : 0;
      const bDone = b.summary.status === "completed" ? 1 : 0;
      if (aDone !== bDone) return bDone - aDone;
      return (b.summary.final_money ?? 0) - (a.summary.final_money ?? 0);
    })
    .map<LeaderboardEntry>((row, i) => ({
      rank: i + 1,
      orchestrator_model: row.summary.orchestrator_model,
      attribution: row.summary.attribution,
      final_money: row.summary.final_money ?? 0,
      bitnodes_completed: row.summary.bitnodes_completed ?? 0,
      augments_installed: row.summary.augments_installed ?? 0,
      status: row.summary.status,
      run_id: row.summary.run_id,
      branch,
      artifact_url: `runs/${row.summary.run_id}/`,
    }));

  const bitburner_commit = summaries[0]?.summary.bitburner_commit ?? "unknown";

  return {
    generated_at: new Date().toISOString(),
    bitburner_commit,
    entries: anonymize(ranked),
  };
}

function renderHtml(board: Leaderboard): string {
  const rows = board.entries
    .map(
      (e) => `<tr>
  <td>${e.rank}</td>
  <td>${escapeHtml(e.orchestrator_model)}</td>
  <td style="text-align: right">${e.final_money.toLocaleString()}</td>
  <td>${e.status}</td>
  <td><a href="${e.artifact_url}">run</a></td>
</tr>`,
    )
    .join("\n");

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Benchburner Leaderboard</title>
<style>
body { font-family: system-ui, sans-serif; max-width: 860px; margin: 2rem auto; padding: 0 1rem; }
table { border-collapse: collapse; width: 100%; }
th, td { padding: 0.5rem 1rem; border-bottom: 1px solid #ddd; }
th { text-align: left; background: #f6f6f6; }
small { color: #777; }
</style>
</head>
<body>
<h1>Benchburner Leaderboard</h1>
<p><small>Generated ${board.generated_at} · bitburner <code>${board.bitburner_commit.slice(0, 8)}</code></small></p>
<table>
<thead><tr><th>Rank</th><th>Orchestrator</th><th>Final Money</th><th>Status</th><th>Artifact</th></tr></thead>
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
  console.log(`Wrote leaderboard with ${board.entries.length} entries to pages/`);
}

main();
