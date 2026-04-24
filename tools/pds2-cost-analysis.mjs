#!/usr/bin/env node
/**
 * PDS2 — cost / throughput analysis.
 *
 * Scrapes token usage from harness log files (/tmp/*.log) and the
 * final [tokens] line per run, then extrapolates 20-min → 24h cost
 * at published OpenRouter prices for frontier orchestrators.
 *
 * Rough blended rates (2026, ~70% input / 30% output):
 *   opus 4.7    ~$32/M
 *   sonnet 4.6  ~$6.60/M
 *   haiku 4.5   ~$1.76/M
 *   gpt-oss:20b $0 (local)
 *
 * Subagent token rates use the same blended numbers as the
 * subagent model.
 */
import { readFileSync, readdirSync } from "node:fs";

// Blended $/M tokens
const RATES = {
  "claude-opus-4.7": 32.0,
  "claude-sonnet-4.6": 6.6,
  "claude-haiku-4.5": 1.76,
  "gpt-oss:20b": 0,
  "qwen2.5-coder:7b": 0,
  "qwen3.5:4b": 0,
};

function priceOf(model) {
  // Handle "anthropic/claude-opus-4.7" and bare ids alike.
  const bare = model.includes("/") ? model.split("/").pop() : model;
  if (RATES[bare] !== undefined) return RATES[bare];
  return 0;
}

// Parse all /tmp/*.log plus /tmp/phase-c*.log plus /tmp/pds*.log
const logPaths = [
  ...readdirSync("/tmp").filter((f) => /\.log$/.test(f) && (/opus|phase-c|pds/.test(f) || /smoke/.test(f))).map((f) => `/tmp/${f}`),
];
// Also include /tmp/opus-run-*
logPaths.push(...readdirSync("/tmp").filter((f) => /opus-run/.test(f)).map((f) => `/tmp/${f}`));

const byRun = new Map();
for (const lp of [...new Set(logPaths)]) {
  let text;
  try { text = readFileSync(lp, "utf8"); } catch { continue; }
  let currentRun = null;
  let currentOrch = null;
  let currentRoster = null;
  for (const line of text.split("\n")) {
    let m;
    if ((m = line.match(/run_id=([0-9a-f-]+)/))) currentRun = m[1];
    else if ((m = line.match(/orchestrator=([^\s]+)/))) currentOrch = m[1];
    else if ((m = line.match(/roster=([^\s]+)/))) currentRoster = m[1];
    else if (line.includes("[tokens]")) {
      const om = line.match(/orch=(\d+)/);
      const sm = line.match(/sub=(\d+)/);
      if (om && sm && currentRun) {
        const prev = byRun.get(currentRun) ?? { orch: 0, sub: 0 };
        byRun.set(currentRun, {
          orch: Math.max(prev.orch, Number(om[1])),
          sub: Math.max(prev.sub, Number(sm[1])),
          orchestrator: currentOrch,
          roster: currentRoster,
          log: lp,
        });
      }
    } else if (line.includes("final_money=")) {
      const fm = line.match(/final_money=(\d+)/);
      if (currentRun && fm) {
        const prev = byRun.get(currentRun);
        if (prev) prev.finalMoney = Number(fm[1]);
      }
      // reset context between runs
      currentRun = currentOrch = currentRoster = null;
    }
  }
}

// Table: run / orch / sub / tokens / cost / extrapolated 24h
const rows = [...byRun.entries()]
  .filter(([, v]) => v.orchestrator)
  .map(([run_id, v]) => {
    const orchRate = priceOf(v.orchestrator);
    const subRate = priceOf(v.roster ?? "");
    const orchCost = (v.orch / 1e6) * orchRate;
    const subCost = (v.sub / 1e6) * subRate;
    const cost20m = orchCost + subCost;
    // 20 min → 24 h = 72×
    const tokens24h = (v.orch + v.sub) * 72;
    const cost24h = cost20m * 72;
    return { run_id: run_id.slice(0, 8), orch: v.orchestrator, sub: v.roster, tokens20m: v.orch + v.sub, cost20m, cost24h, finalMoney: v.finalMoney };
  })
  .sort((a, b) => a.orch.localeCompare(b.orch));

const header = `${"run".padEnd(10)} ${"orch".padEnd(22)} ${"sub".padEnd(22)} ${"tok/20m".padStart(9)} ${"$/20m".padStart(8)} ${"$/24h".padStart(8)} ${"final$".padStart(8)}`;
console.log(header);
console.log("-".repeat(header.length));
for (const r of rows) {
  console.log(`${r.run_id.padEnd(10)} ${(r.orch ?? "?").padEnd(22)} ${(r.sub ?? "?").padEnd(22)} ${String(r.tokens20m).padStart(9)} ${r.cost20m.toFixed(2).padStart(8)} ${r.cost24h.toFixed(2).padStart(8)} ${String(r.finalMoney ?? "?").padStart(8)}`);
}

// By orchestrator summary
console.log(`\n--- aggregated by orchestrator ---`);
const byOrch = new Map();
for (const r of rows) {
  const k = `${r.orch} / ${r.sub ?? "?"}`;
  if (!byOrch.has(k)) byOrch.set(k, []);
  byOrch.get(k).push(r);
}
for (const [k, arr] of byOrch) {
  const avg20m = arr.reduce((s, r) => s + r.cost20m, 0) / arr.length;
  const avg24h = arr.reduce((s, r) => s + r.cost24h, 0) / arr.length;
  const avgMoney = arr.reduce((s, r) => s + (r.finalMoney ?? 0), 0) / arr.length;
  console.log(`${k.padEnd(44)}  n=${arr.length}  avg $/20m=$${avg20m.toFixed(2)}  avg $/24h=$${avg24h.toFixed(2)}  avg final=$${Math.round(avgMoney)}`);
}
