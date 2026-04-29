/**
 * Aggregator — reads per-run JSON artifacts and emits the static
 * leaderboard site under `pages/`. SPEC §8 + §9.
 *
 * Produces, on every run:
 *   pages/index.html             (leaderboard shell)
 *   pages/about.html             (methodology)
 *   pages/runs/<run_id>/index.html  (one per run)
 *   pages/data.js                (window.BB_DATA — feeds the JSX)
 *   pages/leaderboard.json       (machine-readable, model-mean rankings)
 *   pages/styles.css, pages/extra.css   (copied from templates/)
 *   pages/app.jsx, pages/tweaks-panel.jsx,
 *   pages/run-detail.jsx, pages/about.jsx (copied from templates/)
 *
 * The design treats the leaderboard rows as runs (one per run). The
 * machine-readable leaderboard.json keeps the model-mean aggregation
 * so external tooling can rank by mean final_money across runs.
 */

import {
  readFileSync,
  readdirSync,
  writeFileSync,
  copyFileSync,
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

interface RawRunRecord extends RunSummary {
  artifact_url: string;
}

interface MachineLeaderboard {
  generated_at: string;
  bitburner_commit: string;
  entries: AggregateEntry[];
  raw_runs: RawRunRecord[];
}

// ── Design's per-entry shape (one row per run) ─────────────────────
interface DesignDelegationEvent {
  t: string;
  action: string;
  subagent: string;
  note: string;
  ok?: boolean;
}

interface DesignEntry {
  rank: number;
  run_id: string;
  orchestrator_model: string;
  short_name: string;
  family: string;
  attribution: "public" | "anonymous";
  final_money: number;
  bitnodes_completed: number;
  augments_installed: number;
  delegations: number;
  scripts_run: number;
  subagent_errors: number;
  tokens_used: number;
  duration_hours: number;
  status: RunSummary["status"];
  failure_reason: string | null;
  notes: string | null;
  roster: string[];
  snapshots: Array<{ hour: number; money: number }>;
  delegations_sample: DesignDelegationEvent[];
  script_sample: string | null;
  bitburner_commit: string;
  start_time: string;
  branch: string;
}

interface DesignData {
  meta: {
    generated_at: string;
    bitburner_commit: string;
    seed_hash: string | null;
    orchestrators_count: number;
  };
  entries: DesignEntry[];
}

// ── Filesystem helpers ─────────────────────────────────────────────

function readBranch(): string {
  try {
    const head = readFileSync(".git/HEAD", "utf8").trim();
    if (head.startsWith("ref: refs/heads/")) return head.slice("ref: refs/heads/".length);
    return head.slice(0, 7);
  } catch {
    return "unknown";
  }
}

function readJsonIfExists<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function collectRunDirs(resultsDir: string): string[] {
  if (!existsSync(resultsDir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(resultsDir)) {
    const full = path.join(resultsDir, entry);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    if (existsSync(path.join(full, "summary.json"))) out.push(full);
  }
  return out;
}

function stats(xs: number[]): { mean: number; std: number; min: number; max: number } {
  if (xs.length === 0) return { mean: 0, std: 0, min: 0, max: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance =
    xs.length > 1 ? xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1) : 0;
  return {
    mean,
    std: Math.sqrt(variance),
    min: Math.min(...xs),
    max: Math.max(...xs),
  };
}

// ── Model-id → display-name heuristics ─────────────────────────────
//
// These produce a "Pretty Name" + "Family" from a raw model id. They
// only run when attribution=public; anonymous runs get a Submission
// label assigned during ranking.
//
// The heuristic is pure presentation. If a future config carries
// authoritative display metadata, this should defer to it.

interface NameInfo {
  short_name: string;
  family: string;
}

const FAMILY_PREFIXES: Array<{ test: RegExp; family: string }> = [
  { test: /^claude-/, family: "Anthropic" },
  { test: /^llama-?/, family: "Meta" },
  { test: /^gpt-/, family: "OpenAI" },
  { test: /^o[0-9]/, family: "OpenAI" },
  { test: /^gemini/, family: "Google" },
  { test: /^gemma/, family: "Google" },
  { test: /^qwen/, family: "Alibaba" },
  { test: /^deepseek/, family: "DeepSeek" },
  { test: /^mistral/, family: "Mistral" },
  { test: /^mixtral/, family: "Mistral" },
  { test: /^phi/, family: "Microsoft" },
];

function deriveDisplayName(modelId: string, attribution: "public" | "anonymous", anonIndex: number): NameInfo {
  if (attribution === "anonymous") {
    return {
      short_name: `Submission ${String.fromCharCode("A".charCodeAt(0) + anonIndex)}`,
      family: "Anonymous",
    };
  }
  const family = FAMILY_PREFIXES.find((f) => f.test.test(modelId))?.family ?? "Other";
  // Title-case dashes/dots → spaces. "claude-haiku-4-5" → "Claude Haiku 4 5".
  // Collapse adjacent number-runs back into "4.5" form so "haiku-4-5" reads
  // "Haiku 4.5".
  const tokens = modelId.split(/[-_]+/);
  const merged: string[] = [];
  for (const tok of tokens) {
    const last = merged[merged.length - 1];
    if (last && /^\d+$/.test(last) && /^\d+$/.test(tok)) {
      merged[merged.length - 1] = `${last}.${tok}`;
    } else {
      merged.push(tok);
    }
  }
  const short_name = merged
    .map((t) => (/^[A-Z]+$/.test(t) ? t : t.charAt(0).toUpperCase() + t.slice(1)))
    .join(" ");
  return { short_name, family };
}

// ── Per-run artifact loading + design-shape mapping ────────────────

function fmtClock(hour: number, minute = 0): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
}

interface DelegationFileEntry {
  delegation_id: string;
  cycle_number: number;
  subagent_id: string;
  instruction_id: string;
  action: unknown;
  result: unknown;
  timestamp: string;
}

interface ScriptFileEntry {
  script_id: string;
  subagent_id: string;
  instruction_id: string;
  code: string;
  executed_in_game: boolean;
  execution_result: unknown;
  tokens_used: number;
  timestamp: string;
}

interface SnapshotFileEntry {
  snapshot_id: string;
  hour: number;
  game_state: { current_money?: number } & Record<string, unknown>;
  timestamp: string;
}

function summarizeAction(action: unknown, fallback: string): string {
  if (action && typeof action === "object" && "action_type" in action) {
    const t = (action as { action_type: unknown }).action_type;
    if (typeof t === "string") return t;
  }
  return fallback;
}

function noteFromDelegation(d: DelegationFileEntry): { note: string; ok?: boolean } {
  const action = d.action as Record<string, unknown> | null;
  const result = d.result as Record<string, unknown> | null;
  if (action && typeof action.instruction === "object" && action.instruction) {
    const instr = action.instruction as Record<string, unknown>;
    const goal = typeof instr.goal === "string" ? instr.goal
      : typeof instr.task === "string" ? instr.task
      : null;
    if (goal) return { note: goal.slice(0, 240) };
  }
  if (result) {
    const status = typeof result.status === "string" ? result.status : null;
    const summary = typeof result.summary === "string" ? result.summary
      : typeof result.message === "string" ? result.message
      : null;
    if (status === "error" || status === "failed") {
      return { note: summary ?? "subagent reported error", ok: false };
    }
    if (summary) return { note: summary.slice(0, 240), ok: true };
  }
  return { note: `${d.subagent_id} · cycle ${d.cycle_number}` };
}

function buildDelegationSample(delegations: DelegationFileEntry[]): DesignDelegationEvent[] {
  return delegations.slice(0, 16).map((d) => {
    const minutes = d.cycle_number; // 60s cadence assumption (SPEC default)
    const hh = Math.floor(minutes / 60);
    const mm = minutes % 60;
    const { note, ok } = noteFromDelegation(d);
    return {
      t: fmtClock(hh, mm),
      action: summarizeAction(d.action, "instruct"),
      subagent: d.subagent_id,
      note,
      ok,
    };
  });
}

function countDelegationErrors(delegations: DelegationFileEntry[]): number {
  return delegations.reduce((n, d) => {
    const r = d.result as Record<string, unknown> | null;
    if (r && (r.status === "error" || r.status === "failed")) return n + 1;
    return n;
  }, 0);
}

function rosterFromDelegations(delegations: DelegationFileEntry[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const d of delegations) {
    if (!d.subagent_id) continue;
    if (d.subagent_id === "backend") continue;
    if (seen.has(d.subagent_id)) continue;
    seen.add(d.subagent_id);
    order.push(d.subagent_id);
  }
  return order;
}

function pickSampleScript(scripts: ScriptFileEntry[]): string | null {
  if (!scripts.length) return null;
  const executed = scripts.find((s) => s.executed_in_game);
  return (executed ?? scripts[0]).code;
}

function loadDesignEntry(
  runDir: string,
  summary: RunSummary,
  rank: number,
  anonIndex: number,
  branch: string,
): DesignEntry {
  const delegations = readJsonIfExists<DelegationFileEntry[]>(path.join(runDir, "delegations.json")) ?? [];
  const scripts = readJsonIfExists<ScriptFileEntry[]>(path.join(runDir, "scripts.json")) ?? [];
  const snapshotsRaw = readJsonIfExists<SnapshotFileEntry[]>(path.join(runDir, "snapshots.json")) ?? [];

  const snapshots = snapshotsRaw
    .filter((s) => typeof s.hour === "number")
    .sort((a, b) => a.hour - b.hour)
    .map((s) => ({
      hour: s.hour,
      money: typeof s.game_state?.current_money === "number" ? s.game_state.current_money : 0,
    }));

  const tokens_used = scripts.reduce((n, s) => n + (s.tokens_used ?? 0), 0);
  const subagent_errors = countDelegationErrors(delegations);
  const roster = rosterFromDelegations(delegations);
  const { short_name, family } = deriveDisplayName(summary.orchestrator_model, summary.attribution, anonIndex);

  return {
    rank,
    run_id: summary.run_id,
    orchestrator_model: summary.orchestrator_model,
    short_name,
    family,
    attribution: summary.attribution,
    final_money: summary.final_money,
    bitnodes_completed: summary.bitnodes_completed,
    augments_installed: summary.augments_installed,
    delegations: delegations.length,
    scripts_run: scripts.length,
    subagent_errors,
    tokens_used,
    duration_hours: summary.duration_hours,
    status: summary.status,
    failure_reason: summary.failure_reason,
    notes: null,
    roster,
    snapshots,
    delegations_sample: buildDelegationSample(delegations),
    script_sample: pickSampleScript(scripts),
    bitburner_commit: summary.bitburner_commit,
    start_time: summary.start_time,
    branch,
  };
}

// ── Build pipeline ─────────────────────────────────────────────────

interface BuildResult {
  machine: MachineLeaderboard;
  design: DesignData;
}

function build(): BuildResult {
  const branch = readBranch();
  const runDirs = collectRunDirs("results");

  const loaded = runDirs
    .map((dir) => {
      const summary = readJsonIfExists<RunSummary>(path.join(dir, "summary.json"));
      return summary ? { dir, summary } : null;
    })
    .filter((x): x is { dir: string; summary: RunSummary } => x !== null);

  // Rank per-run by final_money desc; failed runs still rank with their
  // partial score (CLAUDE.md: "Partial runs still count").
  const ranked = loaded
    .slice()
    .sort((a, b) => (b.summary.final_money ?? 0) - (a.summary.final_money ?? 0));

  // Anonymous submissions get sequential A/B/C labels in rank order.
  let anonIdx = 0;
  const designEntries: DesignEntry[] = ranked.map((r, i) => {
    const isAnon = r.summary.attribution === "anonymous";
    const idx = isAnon ? anonIdx++ : -1;
    return loadDesignEntry(r.dir, r.summary, i + 1, idx, branch);
  });

  // ── Machine-readable: per-model means (unchanged contract) ────────
  const groups = new Map<string, Array<{ dir: string; summary: RunSummary }>>();
  for (const s of loaded) {
    const key = s.summary.orchestrator_model;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }

  const aggregated: AggregateEntry[] = [];
  let modelAnonCount = 0;
  for (const [model, runs] of groups) {
    const completed = runs.filter((r) => r.summary.status === "completed");
    const failed = runs.filter((r) => r.summary.status === "failed");
    // Only completed runs contribute to the mean; failed-run final_money is
    // partial-score-at-crash and not comparable. They're still in raw_runs.
    const moneys = completed.map((r) => r.summary.final_money ?? 0);
    const s = stats(moneys);
    const latest = runs
      .slice()
      .sort((a, b) => (b.summary.start_time ?? "").localeCompare(a.summary.start_time ?? ""))[0];
    const anyAnon = runs.some((r) => r.summary.attribution === "anonymous");
    const attribution: "public" | "anonymous" = anyAnon ? "anonymous" : "public";
    const display_model =
      attribution === "anonymous"
        ? `Submission ${String.fromCharCode("A".charCodeAt(0) + modelAnonCount++)}`
        : model;

    aggregated.push({
      rank: 0,
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

  const bitburner_commit = ranked[0]?.summary.bitburner_commit ?? "unknown";
  const generated_at = new Date().toISOString();

  const raw_runs: RawRunRecord[] = ranked.map((r) => ({
    ...r.summary,
    artifact_url: `runs/${r.summary.run_id}/`,
  }));

  const machine: MachineLeaderboard = {
    generated_at,
    bitburner_commit,
    entries: aggregated,
    raw_runs,
  };

  const design: DesignData = {
    meta: {
      generated_at,
      bitburner_commit,
      seed_hash: null, // SPEC §6: seed is opaque to viewers too. Surface only when explicitly published.
      orchestrators_count: groups.size,
    },
    entries: designEntries,
  };

  return { machine, design };
}

// ── Emitters ───────────────────────────────────────────────────────

const PAGES_DIR = "pages";
const TEMPLATES_DIR = path.join("aggregator", "templates");

function escapeJsonForScript(json: string): string {
  // </script> in any embedded JSON would close the script tag prematurely.
  // Replace the slash with a unicode escape so the JSON remains valid.
  return json.replace(/<\/script>/gi, "<\\/script>");
}

function copyTemplateAsset(name: string, destSubpath = name): void {
  const src = path.join(TEMPLATES_DIR, name);
  const dest = path.join(PAGES_DIR, destSubpath);
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}

const FONT_LINKS = `<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Space+Grotesk:wght@400;500;600&display=swap" rel="stylesheet" />`;

const REACT_SCRIPTS = `<script src="https://unpkg.com/react@18.3.1/umd/react.development.js" integrity="sha384-hD6/rw4ppMLGNu3tX5cjIb+uRZ7UkRJ6BPkLpg4hAu/6onKUg4lLsHAs9EBPT82L" crossorigin="anonymous"></script>
<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js" integrity="sha384-u6aeetuaXnQ38mYT8rp6sbXaQe3NL9t+IBXmnYxwkUI2Hw4bsp2Wvmx4yRQF1uAm" crossorigin="anonymous"></script>
<script src="https://unpkg.com/@babel/standalone@7.29.0/babel.min.js" integrity="sha384-m08KidiNqLdpJqLq95G/LEi8Qvjl/xUYll3QILypMoQ65QorJ9Lvtp2RXYGBFj1y" crossorigin="anonymous"></script>`;

function indexHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>benchburner — orchestration leaderboard</title>
<link rel="icon" type="image/svg+xml" href="favicon.svg" />
${FONT_LINKS}
<link rel="stylesheet" href="styles.css" />
<link rel="stylesheet" href="extra.css" />
</head>
<body>
<div id="root"></div>
${REACT_SCRIPTS}
<script src="data.js"></script>
<script type="text/babel" src="tweaks-panel.jsx"></script>
<script type="text/babel" src="app.jsx"></script>
</body>
</html>
`;
}

function aboutHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>benchburner — about / methodology</title>
<link rel="icon" type="image/svg+xml" href="favicon.svg" />
${FONT_LINKS}
<link rel="stylesheet" href="styles.css" />
<link rel="stylesheet" href="extra.css" />
</head>
<body>
<div id="root"></div>
${REACT_SCRIPTS}
<script src="data.js"></script>
<script type="text/babel" src="about.jsx"></script>
</body>
</html>
`;
}

function runHtml(runId: string): string {
  const safeId = escapeJsonForScript(JSON.stringify(runId));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>benchburner — run ${escapeHtml(runId)}</title>
<link rel="icon" type="image/svg+xml" href="../../favicon.svg" />
${FONT_LINKS}
<link rel="stylesheet" href="../../styles.css" />
<link rel="stylesheet" href="../../extra.css" />
</head>
<body>
<div id="root"></div>
${REACT_SCRIPTS}
<script>window.BB_RUN_ID = ${safeId};</script>
<script src="../../data.js"></script>
<script type="text/babel" src="../../run-detail.jsx"></script>
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function dataJs(design: DesignData): string {
  const json = JSON.stringify(design, null, 2);
  return `// Generated by aggregator/build.ts. Do not edit by hand.
window.BB_DATA = ${escapeJsonForScript(json)};
`;
}

function emit(machine: MachineLeaderboard, design: DesignData): void {
  mkdirSync(PAGES_DIR, { recursive: true });

  // Static design assets — copied verbatim from templates/.
  for (const asset of ["styles.css", "extra.css", "app.jsx", "tweaks-panel.jsx", "run-detail.jsx", "about.jsx", "favicon.svg"]) {
    copyTemplateAsset(asset);
  }

  // Data + machine-readable leaderboard.
  writeFileSync(path.join(PAGES_DIR, "data.js"), dataJs(design));
  writeFileSync(path.join(PAGES_DIR, "leaderboard.json"), JSON.stringify(machine, null, 2) + "\n");

  // Page shells.
  writeFileSync(path.join(PAGES_DIR, "index.html"), indexHtml());
  writeFileSync(path.join(PAGES_DIR, "about.html"), aboutHtml());

  // Per-run shells. Each run also gets its raw artifact JSONs copied
  // alongside so the page's "raw json" tab links resolve.
  for (const entry of design.entries) {
    const runDir = path.join(PAGES_DIR, "runs", entry.run_id);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, "index.html"), runHtml(entry.run_id));
    for (const artifact of ["summary.json", "delegations.json", "scripts.json", "snapshots.json"]) {
      const src = path.join("results", entry.run_id, artifact);
      if (existsSync(src)) copyFileSync(src, path.join(runDir, artifact));
    }
  }

  console.log(
    `Wrote leaderboard: ${machine.entries.length} orchestrators across ${machine.raw_runs.length} runs ` +
      `→ ${PAGES_DIR}/`,
  );
}

function main(): void {
  const { machine, design } = build();
  emit(machine, design);
}

main();
