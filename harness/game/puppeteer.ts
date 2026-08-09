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
  }: {
    script_id: string;
    subagent_id: string;
    kind?: "probe" | "committed";
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
            return parsed; // likely a failed_to_start
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
        game_state_snapshot: await this.readState().catch(() => staleState()),
        timestamp: new Date().toISOString(),
      };
    }

    // Probe: wait for the dispatcher to produce a result file within
    // 120 s + a small buffer for timeout + write.
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      await sleep(1_000);
      const content = await this.safeGetFile(resultPath);
      if (content) {
        try {
          const parsed = JSON.parse(content) as ExecutionResult;
          await this.rfa!.deleteFile(resultPath, "home");
          return parsed;
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
      game_state_snapshot: await this.readState().catch(() => staleState()),
      timestamp: new Date().toISOString(),
    };
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
        if (typeof parsed.current_money === "number") return parsed;
      } catch {
        /* fall through */
      }
    }
    return staleState();
  }

  // ── internals ──────────────────────────────────────────────────

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
