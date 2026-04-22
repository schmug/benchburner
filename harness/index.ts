/**
 * Run entry point. Reads config/run.yaml, boots the harness, runs for
 * duration_hours, dumps JSONs, commits on the configured branch.
 *
 * Usage (from repo root):
 *   npm run harness:dev         # tsx-backed, reads config/run.yaml
 *   BENCHBURNER_CONFIG=path     # override config file path
 *   BENCHBURNER_DURATION_SEC=N  # override duration (dev only)
 *   BENCHBURNER_USE_MOCK=1      # use MockGame instead of PuppeteerGame
 */

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { Bus } from "./bus/bus";
import { loadRunConfig } from "./config/loader";
import { MockGame } from "./game/mock";
import { PuppeteerGame } from "./game/puppeteer";
import { InferenceRegistry, loadModelsYaml } from "./inference/registry";
import { OrchestratorLoop } from "./orchestrator/loop";
import { SnapshotTimer } from "./snapshot/timer";
import { exportRunArtifacts } from "./storage/export";
import { openDb } from "./storage/db";
import {
  insertRun,
  updateRunStatus,
} from "./storage/writers";
import { SubagentPool, SubagentWorker } from "./subagent";
import type { GameController, GameState } from "./types";

async function main(): Promise<void> {
  const configPath = process.env.BENCHBURNER_CONFIG ?? "config/run.yaml";
  const durationOverrideSec = process.env.BENCHBURNER_DURATION_SEC
    ? Number(process.env.BENCHBURNER_DURATION_SEC)
    : undefined;
  const useMock = process.env.BENCHBURNER_USE_MOCK === "1";

  const config = loadRunConfig(configPath);
  const effectiveDurationSec = durationOverrideSec ?? config.duration_hours * 3600;
  const runDir = path.join("results", config.run_id);
  mkdirSync(runDir, { recursive: true });

  console.log(`[harness] run_id=${config.run_id}`);
  console.log(`[harness] orchestrator=${config.orchestrator.model}`);
  console.log(`[harness] roster=${config.subagent_roster.join(",")}`);
  console.log(`[harness] duration=${effectiveDurationSec}s (${(effectiveDurationSec / 3600).toFixed(2)}h)`);
  console.log(`[harness] game=${useMock ? "mock" : "puppeteer"}`);
  console.log(`[harness] artifacts=${runDir}`);

  // ── Boot subsystems ───────────────────────────────────────────
  const db = openDb(path.join(runDir, "state.db"));
  const registry = new InferenceRegistry(loadModelsYaml("config/models.yaml"));

  insertRun(db, {
    run_id: config.run_id,
    orchestrator_model: config.orchestrator.model,
    orchestrator_config: {
      polling_interval_seconds: config.orchestrator.polling_interval_seconds,
      history_window: config.orchestrator.history_window,
      hang_timeout_seconds: config.orchestrator.hang_timeout_seconds,
    },
    subagent_roster: config.subagent_roster,
    seed: config.game.seed,
    bitburner_commit: config.game.bitburner_commit,
    start_time: new Date().toISOString(),
    attribution_mode: config.attribution_mode,
  });

  const bus = new Bus();
  const pool = new SubagentPool();
  const worker = new SubagentWorker({ bus, registry, pool, limits: config.subagent_limits });
  worker.start();

  const game: GameController = useMock
    ? new MockGame({ seed: config.game.seed })
    : new PuppeteerGame({
        seed: config.game.seed,
        verboseConsole: Boolean(process.env.BENCHBURNER_VERBOSE_GAME),
      });

  let fatal: string | null = null;
  try {
    await game.start();
  } catch (e) {
    fatal = `game boot failed: ${(e as Error).message}`;
    console.error(`[harness] ${fatal}`);
  }

  const initialState: GameState = fatal
    ? { current_money: 0, bitnode_id: 1, bitnode_complete: false }
    : await game.readState();

  const startMs = Date.now();

  const snapshot = new SnapshotTimer({
    run_id: config.run_id,
    startTime: startMs,
    durationHours: Math.ceil(effectiveDurationSec / 3600),
    game,
    bus,
    db,
  });
  if (!fatal) {
    await snapshot.start();
  }

  const loop = new OrchestratorLoop({
    run_id: config.run_id,
    config,
    bus,
    db,
    game,
    pool,
    registry,
    logDir: runDir,
    onFatal: (reason) => {
      if (!fatal) fatal = reason;
      console.error(`[harness] fatal: ${reason}`);
    },
  });
  if (!fatal) {
    loop.start(initialState);
  }

  // ── Wait for duration or fatal ────────────────────────────────
  const deadline = startMs + effectiveDurationSec * 1000;
  while (Date.now() < deadline && !fatal) {
    await sleep(1_000);
  }

  // ── Shutdown ─────────────────────────────────────────────────
  console.log(`[harness] shutting down${fatal ? ` (fatal: ${fatal})` : ""}`);
  await loop.stop();
  snapshot.stop();
  bus.freeze();
  await worker.stop();
  try {
    await game.stop();
  } catch (e) {
    console.error(`[harness] game stop error: ${(e as Error).message}`);
  }

  // ── Finalize ────────────────────────────────────────────────
  const finalState = await safeReadState(game);
  updateRunStatus(db, config.run_id, {
    status: fatal ? "failed" : "completed",
    end_time: new Date().toISOString(),
    final_money: Math.floor(finalState.current_money || 0),
    final_stats: {
      bitnodes_completed: finalState.bitnode_complete ? 1 : 0,
      augments_installed: Array.isArray(finalState.augments_installed) ? finalState.augments_installed.length : 0,
      last_bitnode: finalState.bitnode_id,
    },
    failure_reason: fatal ?? undefined,
  });

  const summary = exportRunArtifacts(db, config.run_id, runDir, config.duration_hours);
  console.log(`[harness] exported artifacts to ${runDir}`);
  console.log(`[harness] final_money=${summary.final_money} status=${summary.status}`);

  db.close();

  // ── Git commit (best-effort; failure is logged but non-fatal) ──
  try {
    commitArtifacts(runDir, config.run_id);
  } catch (e) {
    console.error(`[harness] git commit failed: ${(e as Error).message}`);
  }

  process.exit(fatal ? 1 : 0);
}

async function safeReadState(game: GameController): Promise<GameState> {
  try {
    return await game.readState();
  } catch {
    return { current_money: 0, bitnode_id: 1, bitnode_complete: false };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function commitArtifacts(runDir: string, run_id: string): void {
  // Uses execFileSync (no shell) so run_id cannot shell-escape.
  execFileSync("git", ["add", runDir], { stdio: "inherit" });
  const msg = `run ${run_id}: artifacts\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`;
  execFileSync("git", ["commit", "-m", msg], { stdio: "inherit" });
}

void main().catch((e) => {
  console.error(`[harness] fatal at top level: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
