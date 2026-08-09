/**
 * PuppeteerGame — real `GameController` backed by headless Chromium
 * driving a locally-served Bitburner build at the pinned commit.
 *
 * Boot sequence:
 *   1. Serve `bitburner/src/` over a local HTTP server.
 *   2. Launch Chromium (system Chrome via PUPPETEER_EXECUTABLE_PATH).
 *   3. Inject `seed-inject.js` via `evaluateOnNewDocument` so the
 *      seeded `Math.random` and `__BENCHBURNER_RFA_PORT` are in place
 *      before Bitburner executes.
 *   4. Start an RFA WebSocket server on the port.
 *   5. Navigate to the served index.html. Bitburner's boot-time hook
 *      patch (bitburner/patches/0001) reads the port and auto-connects.
 *   6. Wait for RFA connect.
 *   7. Push the dispatcher script and ns.run it via the in-game
 *      terminal (Puppeteer types `run __dispatcher.js` + Enter).
 *   8. Poll for `/__state.json` to appear, confirming the dispatcher
 *      is alive. Game is now ready.
 */

import { createServer, type Server as HttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

import puppeteer, { type Browser, type Page } from "puppeteer";

import type { ExecutionResult, GameController, GameState } from "../types";
import { killTargets, type QueueTask } from "./eviction";
import { RFAServer } from "./rfa";

/**
 * Sentinel game state used when an actual RFA read failed. The
 * `read_failed: true` flag lets callers (notably OrchestratorLoop)
 * refuse to overwrite a previously-good cached state with this fake.
 *
 * Without the flag, every RFA failure looks like a genuine money=0
 * snapshot — which is what poisoned PDS7's orchestrator loop after
 * the cycle-16 socket timeout.
 */
function staleState(): GameState {
  return {
    current_money: 0,
    bitnode_id: 1,
    bitnode_complete: false,
    read_failed: true,
  };
}

/**
 * Restores the fields the dispatcher stopped reporting to save RAM.
 *
 * The full dispatcher omits bitnode_id (ns.getResetInfo costs 1.0 GB a
 * tick for a run-constant), so the boot-probed value is authoritative
 * and overwrites whatever is on the object.
 *
 * `dispatcher-light.js` is the exception: it does not process the queue,
 * so it has the headroom to report bitnode_id itself — and the boot
 * probe cannot run in that mode at all, leaving `cachedBitnodeId` at its
 * untested default. There the reported reading wins.
 *
 * Exported as a pure function so both branches are testable without
 * booting Chromium.
 */
export function mergeCachedFields(
  state: GameState,
  opts: { cachedBitnodeId: number; lightDispatcher: boolean; startingMoney: number | null },
): GameState {
  const reported = state.bitnode_id;
  const useReported = opts.lightDispatcher && typeof reported === "number";
  const current = typeof state.current_money === "number" ? state.current_money : 0;
  // Before the baseline is captured (boot, or every read failing so far)
  // the current balance IS the baseline, so money_earned reads 0 rather
  // than reporting the starting capital as revenue.
  const starting = opts.startingMoney ?? current;
  return {
    ...state,
    bitnode_id: useReported ? reported : opts.cachedBitnodeId,
    bitnode_complete: false,
    starting_money: starting,
    money_earned: current - starting,
  };
}

/**
 * The run's money baseline: the balance on the first successful state
 * read. Captured exactly once — Bitburner starts the player at $1,262,
 * and reporting that balance as-is taught two real orchestrators to
 * read their starting capital as revenue.
 *
 * A `read_failed` placeholder must never become the baseline: it
 * reports current_money 0, which would turn the untouched starting
 * balance into fake profit on the next good read.
 *
 * Pure for the same reason as mergeCachedFields: testable without
 * booting Chromium.
 */
export function captureStartingMoney(prev: number | null, state: GameState): number | null {
  if (prev !== null) return prev;
  if (state.read_failed) return null;
  return typeof state.current_money === "number" ? state.current_money : null;
}

/**
 * Poll budget for a probe result. The dispatcher bounds probe execution
 * at ~120 s; the rest is buffer for its timeout handling and the result
 * write.
 */
const PROBE_RESULT_TIMEOUT_MS = 180_000;

/**
 * The boot probe is a two-line ns.print. A dispatcher that services the
 * queue at all answers it in about a second, so there is nothing to gain
 * from the full probe budget — and a dispatcher that never services it
 * (the light one, or a future variant that drops queue handling) should
 * cost the boot sequence seconds rather than three minutes.
 */
const BOOT_PROBE_TIMEOUT_MS = 15_000;

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
// Resolve to source dir regardless of whether we're running via tsx or compiled.
const HARNESS_GAME_SRC_DIR = path.resolve(MODULE_DIR);
const REPO_ROOT = path.resolve(HARNESS_GAME_SRC_DIR, "..", "..");

export interface PuppeteerGameOptions {
  seed: number;
  rfaPort?: number; // default 12525
  httpPort?: number; // 0 → ephemeral
  bitburnerDir?: string; // absolute path to bitburner/src
  headless?: boolean; // default true
  chromeExecutable?: string; // overrides PUPPETEER_EXECUTABLE_PATH
  /** Path to write screenshots / logs on fatal boot errors. */
  debugDir?: string;
  /** When true, log verbose console messages from the game. */
  verboseConsole?: boolean;
  /**
   * When true, push the lightweight state-only dispatcher instead of
   * the full queue-processing one. Frees ~1.5 GB of home RAM so
   * golden / validation scripts can coexist on the default 8-GB home.
   * The harness can't submit agentic probes or committed scripts in
   * this mode — state reads only.
   */
  lightDispatcher?: boolean;
}

/**
 * Where a system Chrome normally lives, most-preferred first. Puppeteer's
 * own bundled Chromium is deliberately not installed (setup uses
 * PUPPETEER_SKIP_DOWNLOAD=true), so without one of these the launch fails
 * pointing at an empty cache directory instead of at the real problem.
 */
const SYSTEM_CHROME_CANDIDATES: readonly string[] = [
  // macOS
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  // Linux
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/snap/bin/chromium",
];

/**
 * Resolves the browser binary to drive, in order: an explicitly
 * configured path, `PUPPETEER_EXECUTABLE_PATH`, then a system install.
 *
 * Throws rather than returning undefined when nothing is found. Handing
 * `undefined` to Puppeteer makes it hunt for a bundled Chromium this
 * project never downloads, and the resulting error names a cache
 * directory rather than the remedy — which is how a run failed with
 * "Could not find Chrome (ver. 131.0.6778.204)" long after boot began.
 *
 * A configured-but-missing path also throws: falling back silently would
 * hide the typo and quietly run a different browser than intended.
 */
export function resolveChromeExecutable(opts: {
  explicit?: string;
  env?: string;
  /** Overridable for tests; defaults to the platform candidate list. */
  candidates?: readonly string[];
}): string {
  const configured = opts.explicit ?? opts.env;
  if (configured) {
    if (!existsSync(configured)) {
      const source = opts.explicit ? "chromeExecutable" : "PUPPETEER_EXECUTABLE_PATH";
      throw new Error(
        `Chrome not found at the configured path (${source}): ${configured}`,
      );
    }
    return configured;
  }

  const candidates = opts.candidates ?? SYSTEM_CHROME_CANDIDATES;
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(
    "Chrome not found. The harness drives the system Chrome and does not " +
      "download Puppeteer's bundled Chromium. Install Google Chrome, or set " +
      "PUPPETEER_EXECUTABLE_PATH to an existing browser binary. Looked in: " +
      candidates.join(", "),
  );
}

export class PuppeteerGame implements GameController {
  private readonly opts: Required<
    Omit<
      PuppeteerGameOptions,
      "debugDir" | "chromeExecutable" | "verboseConsole" | "lightDispatcher"
    >
  > & {
    debugDir?: string;
    chromeExecutable?: string;
    verboseConsole: boolean;
    lightDispatcher: boolean;
  };
  private http?: HttpServer;
  private rfa?: RFAServer;
  private browser?: Browser;
  private page?: Page;
  private started = false;
  private stopping = false;
  private httpPortActual = 0;
  private rfaPortActual = 0;
  /**
   * Read once at boot. Constant for a run, and 1.0 GB/tick to poll from
   * inside the game, so the dispatcher no longer reports it — every
   * GameState this class hands out gets it merged back in here.
   */
  private bitnodeId = 1;
  /** Captured on the first successful state read; the run's baseline. */
  private startingMoney: number | null = null;
  /** Set at the top of start(); see resolveChromeExecutable. */
  private resolvedChrome?: string;

  constructor(opts: PuppeteerGameOptions) {
    this.opts = {
      seed: opts.seed,
      rfaPort: opts.rfaPort ?? 12525,
      httpPort: opts.httpPort ?? 0,
      bitburnerDir: opts.bitburnerDir ?? path.join(REPO_ROOT, "bitburner", "src"),
      headless: opts.headless ?? true,
      debugDir: opts.debugDir,
      chromeExecutable: opts.chromeExecutable,
      verboseConsole: opts.verboseConsole ?? false,
      lightDispatcher: opts.lightDispatcher ?? false,
    };
  }

  async start(): Promise<void> {
    if (this.started) return;
    // Resolve the browser before anything is bound or spawned. This used
    // to happen inside launchBrowser(), two servers later, so a missing
    // Chrome surfaced as a mid-boot failure instead of an immediate one.
    this.resolvedChrome = resolveChromeExecutable({
      explicit: this.opts.chromeExecutable,
      env: process.env.PUPPETEER_EXECUTABLE_PATH,
    });
    await this.startHttpServer();
    await this.startRfaServer();
    await this.launchBrowser();
    await this.navigateAndWaitForRfa();
    await this.pushDispatcher();
    await this.runDispatcher();
    await this.waitForDispatcherAlive();
    this.started = true;
    await this.probeBitnodeId();
  }

  /**
   * Reads bitnode_id once, via a throwaway in-game script, so that
   * ns.getResetInfo (1.0 GB) stays out of the dispatcher's permanent
   * per-tick budget. Must run after `started` is set — submitScript and
   * runScript both go through requireReady().
   *
   * A failure here is not fatal: bitnode 1 is the pinned scenario, and
   * losing the benchmark to a boot probe would be a worse trade than
   * reporting a default.
   */
  private async probeBitnodeId(): Promise<void> {
    // The probe is dispatched through /__queue.json, and
    // dispatcher-light.js never reads that file — so in light mode the
    // entry is never serviced and the probe can only ever run out its
    // deadline. It used to inherit the 180 s probe budget, which turned
    // every golden-script boot into a three-minute stall that ended by
    // discarding the bitnode_id the light dispatcher had been reporting
    // correctly the whole time. It reports its own; leave it alone.
    if (this.opts.lightDispatcher) return;
    try {
      const probeId = "__bootprobe";
      await this.submitScript({
        script_id: probeId,
        // ns.print, not ns.tprint: only the script's own log buffer is
        // captured into ExecutionResult.stdout.
        code:
          "/** @param {NS} ns */\nexport async function main(ns) {" +
          " ns.print('BITNODE=' + ns.getResetInfo().currentNode); }",
      });
      const res = await this.runScript({
        script_id: probeId,
        subagent_id: "boot",
        kind: "probe",
        timeout_ms: BOOT_PROBE_TIMEOUT_MS,
      });
      const m = /BITNODE=(\d+)/.exec(res.stdout ?? "");
      if (m) this.bitnodeId = Number(m[1]);
      else console.warn(`[game] bitnode probe returned no value, assuming ${this.bitnodeId}`);
    } catch (e) {
      console.warn(`[game] bitnode probe failed, assuming 1: ${(e as Error).message}`);
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    try {
      if (this.browser) await this.browser.close();
    } catch {
      /* ignore */
    }
    try {
      if (this.rfa) await this.rfa.close();
    } catch {
      /* ignore */
    }
    if (this.http) {
      await new Promise<void>((r) => this.http!.close(() => r()));
    }
  }

  async submitScript({ script_id, code }: { script_id: string; code: string }): Promise<void> {
    this.requireReady();
    const filename = this.scriptFilename(script_id);
    await this.rfa!.pushFile(filename, code, "home");
  }

  async runScript({
    script_id,
    subagent_id,
    kind = "probe",
    replace = false,
    timeout_ms,
  }: {
    script_id: string;
    subagent_id: string;
    kind?: "probe" | "committed";
    /**
     * Retire the subagent's previous committed script once this one is
     * confirmed running. Defaults to false — the dispatcher reads the
     * flag off the queue entry and evicts only on an explicit `true`.
     */
    replace?: boolean;
    /** Probe-result poll budget; defaults to PROBE_RESULT_TIMEOUT_MS. */
    timeout_ms?: number;
  }): Promise<ExecutionResult> {
    this.requireReady();
    const resultPath = `/__results/${script_id}.json`;
    // Enqueue the task via RFA by rewriting /__queue.json.
    const queueRaw = await this.safeGetFile("/__queue.json");
    const queue: Array<Record<string, unknown>> = queueRaw ? safeJsonParseArray(queueRaw) : [];
    queue.push({
      script_id,
      subagent_id,
      path: this.scriptFilename(script_id),
      status: "pending",
      kind,
      replace,
    });
    await this.rfa!.pushFile("/__queue.json", JSON.stringify(queue), "home");

    if (kind === "committed") {
      // Committed scripts are long-running. Wait briefly for either a
      // failed_to_start result (RAM / file issue surfaces in ~1 s) or
      // confirmation the task transitioned to "running", then return a
      // placeholder so the orchestrator cycle isn't blocked. The real
      // money-gained signal flows via game_state snapshots.
      const startDeadline = Date.now() + 10_000;
      while (Date.now() < startDeadline) {
        await sleep(500);
        const resultContent = await this.safeGetFile(resultPath);
        if (resultContent) {
          try {
            const parsed = JSON.parse(resultContent) as ExecutionResult;
            await this.rfa!.deleteFile(resultPath, "home");
            return this.withCachedSnapshot(parsed); // likely a failed_to_start
          } catch {
            /* mid-write, retry */
          }
        }
        // Check queue state for a "running" transition.
        const cur = await this.safeGetFile("/__queue.json");
        if (cur) {
          try {
            const q = JSON.parse(cur) as Array<{ script_id: string; status?: string }>;
            const me = q.find((t) => t.script_id === script_id);
            if (me?.status === "running") break;
          } catch {
            /* ignore */
          }
        }
      }
      return {
        script_id,
        subagent_id,
        status: "executed",
        money_gained: 0,
        time_elapsed_seconds: 0,
        exit_reason: "running",
        game_state_snapshot: await this.readState().catch(() => this.withCachedFields(staleState())),
        timestamp: new Date().toISOString(),
      };
    }

    // Probe: wait for the dispatcher to produce a result file. Callers
    // that know their script is trivial pass a shorter timeout_ms rather
    // than sitting out the full dispatcher-bounded budget.
    const deadline = Date.now() + (timeout_ms ?? PROBE_RESULT_TIMEOUT_MS);
    while (Date.now() < deadline) {
      await sleep(1_000);
      const content = await this.safeGetFile(resultPath);
      if (content) {
        try {
          const parsed = JSON.parse(content) as ExecutionResult;
          await this.rfa!.deleteFile(resultPath, "home");
          return this.withCachedSnapshot(parsed);
        } catch {
          // dispatcher mid-write; retry
        }
      }
    }
    return {
      script_id,
      subagent_id,
      status: "failed",
      money_gained: 0,
      time_elapsed_seconds: 0,
      error: "harness polling timed out waiting for dispatcher result",
      game_state_snapshot: await this.readState().catch(() => this.withCachedFields(staleState())),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Ask the dispatcher to stop this subagent's committed script.
   *
   * Rides the existing /__queue.json channel rather than adding a second
   * control file: the dispatcher already reads that file every tick and
   * already holds the pid, so a flag on the task is the whole mechanism.
   *
   * Returns once the request is written, not once the script is dead —
   * the dispatcher acts on its next tick (≤500 ms) and reports the
   * outcome through the normal result path with `exit_reason: "killed"`.
   */
  async killScript(subagent_id: string): Promise<void> {
    this.requireReady();
    const raw = await this.safeGetFile("/__queue.json");
    if (!raw) return;
    const queue = safeJsonParseArray(raw);
    const targets = killTargets(queue as QueueTask[], subagent_id);
    if (targets.length === 0) return;
    for (const t of targets) t.kill_requested = true;
    await this.rfa!.pushFile("/__queue.json", JSON.stringify(queue), "home");
  }

  /**
   * Push a script to home and start it via the in-game terminal. Used
   * by golden-script validation runs (VALIDATION.md P0S1) which want
   * a long-running script that doesn't get killed by the dispatcher's
   * 120s probe-kill timeout. The dispatcher won't see this script at
   * all since it's not in /__queue.json.
   */
  async directTerminalRun(filename: string, code: string): Promise<void> {
    this.requireReady();
    await this.rfa!.pushFile(filename, code, "home");
    if (!this.page) throw new Error("page not initialized");
    await this.page.waitForSelector("#terminal-input", { timeout: 10_000 });
    await this.page.click("#terminal-input");
    await this.page.focus("#terminal-input");
    await this.page.keyboard.type(`run ${filename}`);
    await this.page.keyboard.press("Enter");
    await new Promise((r) => setTimeout(r, 1500));
    // Diagnostic: dump the last 2KB of terminal text so we can tell
    // from the harness log whether the run command was accepted.
    try {
      const tail = await this.page.evaluate(() => {
        const terminal = document.getElementById("terminal");
        const text = terminal?.innerText ?? "(no #terminal element)";
        return text.slice(-2048);
      });
      console.log(`[puppeteer] terminal tail after 'run ${filename}':\n${tail}`);
    } catch (e) {
      console.warn(`[puppeteer] terminal dump failed: ${(e as Error).message}`);
    }
  }

  /** Raw RFA file read, for harness-level diagnostics. */
  async readFile(filename: string, server = "home"): Promise<string | null> {
    if (!this.rfa?.isConnected()) return null;
    return this.safeGetFile(filename, server);
  }

  async readState(): Promise<GameState> {
    this.requireReady();
    const raw = await this.safeGetFile("/__state.json");
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as GameState;
        if (typeof parsed.current_money === "number") return this.withCachedFields(parsed);
      } catch {
        /* fall through */
      }
    }
    return this.withCachedFields(staleState());
  }

  // ── internals ──────────────────────────────────────────────────

  /**
   * Restores the fields the dispatcher stopped reporting to save RAM.
   * Applied to the read_failed placeholder too, so a failed read is
   * still shape-identical to a good one — consumers distinguish them by
   * the flag, never by which keys are present.
   *
   * Also the one place the money baseline is captured: every GameState
   * this class hands out passes through here, execution-result
   * snapshots included, so the first successful read anywhere becomes
   * the run's starting_money.
   */
  private withCachedFields(state: GameState): GameState {
    this.startingMoney = captureStartingMoney(this.startingMoney, state);
    return mergeCachedFields(state, {
      cachedBitnodeId: this.bitnodeId,
      lightDispatcher: this.opts.lightDispatcher,
      startingMoney: this.startingMoney,
    });
  }

  /**
   * Same restoration for the snapshot the dispatcher embeds in a result
   * file. OrchestratorLoop feeds that snapshot straight into
   * acceptIncomingState, so without this a single script result would
   * strip bitnode_id back out of the cached game state.
   */
  private withCachedSnapshot(result: ExecutionResult): ExecutionResult {
    if (!result.game_state_snapshot) return result;
    return { ...result, game_state_snapshot: this.withCachedFields(result.game_state_snapshot) };
  }

  private requireReady(): void {
    if (!this.started) throw new Error("PuppeteerGame.start() has not completed");
    if (!this.rfa?.isConnected()) throw new Error("RFA socket is not connected");
  }

  private scriptFilename(script_id: string): string {
    return `/__scripts/${script_id}.js`;
  }

  private async startHttpServer(): Promise<void> {
    const staticDir = this.opts.bitburnerDir;
    this.http = createServer(async (req, res) => {
      const urlPath = (req.url ?? "/").split("?")[0];
      let relPath = urlPath === "/" ? "/index.html" : urlPath;
      // Disallow path traversal.
      relPath = relPath.replace(/\.\./g, "");
      const abs = path.join(staticDir, relPath);
      try {
        const data = await readFile(abs);
        res.writeHead(200, { "Content-Type": contentTypeFor(abs) });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end("not found");
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.http!.listen(this.opts.httpPort, "127.0.0.1", () => resolve());
      this.http!.on("error", reject);
    });
    const addr = this.http.address();
    if (!addr || typeof addr === "string") throw new Error("could not bind HTTP server");
    this.httpPortActual = addr.port;
  }

  private async startRfaServer(): Promise<void> {
    this.rfa = new RFAServer({ port: this.opts.rfaPort });
    this.rfaPortActual = this.opts.rfaPort;
  }

  private async launchBrowser(): Promise<void> {
    const execPath = this.resolvedChrome;
    this.browser = await puppeteer.launch({
      headless: this.opts.headless,
      executablePath: execPath,
      args: [
        "--no-sandbox",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
        "--disable-features=CalculateNativeWinOcclusion",
      ],
    });
    this.page = await this.browser.newPage();
    if (this.opts.verboseConsole) {
      this.page.on("console", (msg) => console.log(`[bitburner console] ${msg.type()}: ${msg.text()}`));
      this.page.on("pageerror", (err) => console.error(`[bitburner page error] ${err.message}`));
    }
    const seedInjectSrc = readFileSync(path.join(HARNESS_GAME_SRC_DIR, "seed-inject.js"), "utf8");
    const prepared = seedInjectSrc
      .replaceAll("__BENCHBURNER_SEED__", String(this.opts.seed))
      .replaceAll("__BENCHBURNER_PORT__", String(this.rfaPortActual));
    await this.page.evaluateOnNewDocument(prepared);
  }

  private async navigateAndWaitForRfa(): Promise<void> {
    if (!this.page || !this.rfa) throw new Error("unexpected state");
    const url = `http://127.0.0.1:${this.httpPortActual}/`;
    await this.page.goto(url, { waitUntil: "networkidle2", timeout: 60_000 });
    // RFA auto-connects ~2s after boot per Bitburner's setTimeout.
    await this.rfa.waitForConnect(30_000);
  }

  private async pushDispatcher(): Promise<void> {
    const file = this.opts.lightDispatcher ? "dispatcher-light.js" : "dispatcher.js";
    const dispatcherSrc = readFileSync(path.join(HARNESS_GAME_SRC_DIR, file), "utf8");
    await this.rfa!.pushFile("/__dispatcher.js", dispatcherSrc, "home");
  }

  private async runDispatcher(): Promise<void> {
    // Bitburner's terminal accepts commands via keyboard. Click the
    // terminal input via Puppeteer and type `run __dispatcher.js`.
    if (!this.page) throw new Error("unexpected");
    // Find the terminal input by its placeholder or role. Bitburner
    // uses a MUI TextField; the input's id is "terminal-input".
    await this.page.waitForSelector("#terminal-input", { timeout: 30_000 });
    await this.page.focus("#terminal-input");
    await this.page.keyboard.type("run /__dispatcher.js");
    await this.page.keyboard.press("Enter");
  }

  private async waitForDispatcherAlive(): Promise<void> {
    // The dispatcher previously failed silently: it wrote /__state.json
    // once at boot then exited or stalled, and a "current_money is a
    // number" check passed forever on the stale file. PDS7 spent 24h
    // polling 1262. Real liveness requires either the heartbeat or
    // the money value to ADVANCE between samples.
    const deadline = Date.now() + 30_000;
    let firstHeartbeat: number | null = null;
    let firstMoney: number | null = null;
    let firstSeenAt = 0;
    let sawAnything = false;
    while (Date.now() < deadline) {
      await sleep(500);
      const raw = await this.safeGetFile("/__state.json");
      if (!raw) continue;
      let parsed: GameState;
      try {
        parsed = JSON.parse(raw) as GameState;
      } catch {
        continue;
      }
      if (typeof parsed.current_money !== "number") continue;
      sawAnything = true;
      const hb = typeof parsed.last_heartbeat_ms === "number" ? parsed.last_heartbeat_ms : null;
      const money = parsed.current_money;
      if (firstHeartbeat === null && firstMoney === null) {
        firstHeartbeat = hb;
        firstMoney = money;
        firstSeenAt = Date.now();
        continue;
      }
      // Wait at least 2s after the first sighting before declaring
      // advancement — the dispatcher loop sleeps 500ms, so 2s is
      // ~4 iterations and well outside any single-iteration jitter.
      if (Date.now() - firstSeenAt < 2_000) continue;
      const heartbeatAdvanced = hb !== null && firstHeartbeat !== null && hb > firstHeartbeat;
      const moneyAdvanced = firstMoney !== null && money !== firstMoney;
      if (heartbeatAdvanced || moneyAdvanced) return;
    }
    if (sawAnything) {
      throw new Error(
        "dispatcher wrote /__state.json but neither heartbeat nor money advanced within 30s — dispatcher is dead or stalled after first iteration",
      );
    }
    throw new Error("dispatcher failed to produce /__state.json within 30s");
  }

  private async safeGetFile(filename: string, server = "home"): Promise<string | null> {
    try {
      const r = await this.rfa!.getFile(filename, server);
      return r || null;
    } catch {
      return null;
    }
  }
}

function contentTypeFor(abs: string): string {
  if (abs.endsWith(".html")) return "text/html; charset=utf-8";
  if (abs.endsWith(".js") || abs.endsWith(".mjs")) return "application/javascript; charset=utf-8";
  if (abs.endsWith(".css")) return "text/css";
  if (abs.endsWith(".json")) return "application/json";
  if (abs.endsWith(".ico")) return "image/x-icon";
  if (abs.endsWith(".wasm")) return "application/wasm";
  if (abs.endsWith(".png")) return "image/png";
  if (abs.endsWith(".svg")) return "image/svg+xml";
  if (abs.endsWith(".woff2")) return "font/woff2";
  if (abs.endsWith(".woff")) return "font/woff";
  if (abs.endsWith(".txt")) return "text/plain";
  if (abs.endsWith(".map")) return "application/json";
  return "application/octet-stream";
}

function safeJsonParseArray(s: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
