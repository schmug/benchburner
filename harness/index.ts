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
import { mkdirSync, readFileSync } from "node:fs";
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
  const goldenScriptPath = process.env.BENCHBURNER_GOLDEN_SCRIPT;
  const maxTokensEnv = process.env.BENCHBURNER_MAX_TOKENS;
  const maxTokensCap = maxTokensEnv ? Number(maxTokensEnv) : Number.POSITIVE_INFINITY;

  const config = loadRunConfig(configPath);
  const effectiveDurationSec = durationOverrideSec ?? config.duration_hours * 3600;
  const runDir = path.join("results", config.run_id);
  mkdirSync(runDir, { recursive: true });

  console.log(`[harness] run_id=${config.run_id}`);
  console.log(`[harness] orchestrator=${config.orchestrator.model}`);
  console.log(`[harness] roster=${config.subagent_roster.join(",")}`);
  console.log(`[harness] duration=${effectiveDurationSec}s (${(effectiveDurationSec / 3600).toFixed(2)}h)`);
  console.log(`[harness] game=${useMock ? "mock" : "puppeteer"}`);
  if (goldenScriptPath) {
    console.log(`[harness] GOLDEN-SCRIPT MODE — orchestrator loop bypassed; running ${goldenScriptPath}`);
  }
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

  const game: GameController = useMock
    ? new MockGame({ seed: config.game.seed })
    : new PuppeteerGame({
        seed: config.game.seed,
        verboseConsole: Boolean(process.env.BENCHBURNER_VERBOSE_GAME),
        // Golden/validation mode bypasses the orchestrator, so we don't
        // need the queue-processing dispatcher. The lighter variant
        // frees enough home RAM for a second long-running script.
        lightDispatcher: Boolean(goldenScriptPath),
      });

  let fatal: string | null = null;
  try {
    await game.start();
  } catch (e) {
    fatal = `game boot failed: ${(e as Error).message}`;
    console.error(`[harness] ${fatal}`);
  }

  // Worker depends on the game controller for its write-run-observe
  // iterations, so it's constructed after the game is ready.
  const worker = new SubagentWorker({
    bus,
    registry,
    pool,
    limits: config.subagent_limits,
    game,
  });
  if (!fatal) worker.start();

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
  if (!fatal && !goldenScriptPath) {
    loop.start(initialState);
  }

  // Golden-script mode (VALIDATION.md P0S1): push the script into
  // the game's filesystem and start it directly via the in-game
  // terminal, bypassing the orchestrator/worker path. Lets us measure
  // what the game integration can produce on its own, without any LLM
  // in the loop.
  if (!fatal && goldenScriptPath && !useMock) {
    try {
      const code = readFileSync(goldenScriptPath, "utf8");
      const filename = "/__golden.js";
      // Cast to any to reach PuppeteerGame's specific method without a
      // narrower type import at this layer.
      await (game as unknown as { directTerminalRun(filename: string, code: string): Promise<void> }).directTerminalRun(filename, code);
      console.log(`[harness] golden script started: ${filename}`);
    } catch (e) {
      fatal = `golden script launch failed: ${(e as Error).message}`;
      console.error(`[harness] ${fatal}`);
    }
  }

  // ── SIGINT/SIGTERM: trigger clean shutdown instead of abrupt ──
  // A second signal within 5s aborts fully (useful if shutdown itself
  // is hung). CLAUDE.md §"Failure Handling": partial artifacts still
  // commit with status=failed + failure_reason.
  let signalledAt = 0;
  const installSignalHandler = (sig: NodeJS.Signals) => {
    process.on(sig, () => {
      if (signalledAt && Date.now() - signalledAt < 5_000) {
        console.error(`[harness] second ${sig} received, aborting`);
        process.exit(130);
      }
      signalledAt = Date.now();
      if (!fatal) fatal = `received ${sig}`;
      console.error(`[harness] ${sig} received; draining and committing partial artifacts`);
    });
  };
  installSignalHandler("SIGINT");
  installSignalHandler("SIGTERM");

  // ── Wait for duration or fatal ────────────────────────────────
  const deadline = startMs + effectiveDurationSec * 1000;
  // In golden-script mode, log money every 30s so we can see whether
  // the script is actually earning. Cheap diagnostic, no benchmark
  // impact since golden mode skips the orchestrator anyway.
  const progressInterval = goldenScriptPath ? 30_000 : 0;
  let lastProgressLog = Date.now();
  let lastTokenLog = Date.now();
  const TOKEN_LOG_INTERVAL_MS = 120_000;
  while (Date.now() < deadline && !fatal) {
    await sleep(1_000);
    // Cost cap: sum orchestrator + subagent inference tokens and bail
    // if we cross BENCHBURNER_MAX_TOKENS. Protects against runaway
    // hosted-API spend.
    const tokensSoFar = loop.tokensUsedTotal + worker.tokensUsedTotal;
    if (Number.isFinite(maxTokensCap) && tokensSoFar > maxTokensCap) {
      fatal = `token cap exceeded: ${tokensSoFar} > ${maxTokensCap}`;
      console.error(`[harness] ${fatal}`);
      break;
    }
    if (Date.now() - lastTokenLog >= TOKEN_LOG_INTERVAL_MS) {
      lastTokenLog = Date.now();
      console.log(
        `[tokens] orch=${loop.tokensUsedTotal} sub=${worker.tokensUsedTotal} total=${tokensSoFar}${Number.isFinite(maxTokensCap) ? `/${maxTokensCap}` : ""}`,
      );
    }
    if (progressInterval && Date.now() - lastProgressLog >= progressInterval) {
      lastProgressLog = Date.now();
      try {
        const s = await game.readState();
        const elapsed = Math.round((Date.now() - startMs) / 1000);
        // Pull the golden script's own per-iteration diagnostic too.
        const diag = await (game as unknown as {
          readFile?(path: string): Promise<string | null>;
        }).readFile?.("/__golden_diag.json").catch(() => null);
        const diagStr = diag ? ` diag=${diag.slice(0, 400)}` : "";
        console.log(`[golden] t+${elapsed}s state_money=${s.current_money}${diagStr}`);
      } catch (e) {
        console.warn(`[golden] readState failed: ${(e as Error).message}`);
      }
    }
  }

  // ── Shutdown ─────────────────────────────────────────────────
  console.log(`[harness] shutting down${fatal ? ` (fatal: ${fatal})` : ""}`);
  await loop.stop();
  snapshot.stop();
  bus.freeze();
  await worker.stop();

  // Capture final state BEFORE closing the game (the browser/RFA goes
  // away on stop() and readState would return the fallback zero).
  const finalState = await safeReadState(game);

  try {
    await game.stop();
  } catch (e) {
    console.error(`[harness] game stop error: ${(e as Error).message}`);
  }

  // ── Finalize ────────────────────────────────────────────────
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
