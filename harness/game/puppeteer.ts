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
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

import puppeteer, { type Browser, type Page } from "puppeteer";

import type { ExecutionResult, GameController, GameState } from "../types";
import { RFAServer } from "./rfa";

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
}

export class PuppeteerGame implements GameController {
  private readonly opts: Required<
    Omit<PuppeteerGameOptions, "debugDir" | "chromeExecutable" | "verboseConsole">
  > & {
    debugDir?: string;
    chromeExecutable?: string;
    verboseConsole: boolean;
  };
  private http?: HttpServer;
  private rfa?: RFAServer;
  private browser?: Browser;
  private page?: Page;
  private started = false;
  private stopping = false;
  private httpPortActual = 0;
  private rfaPortActual = 0;

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
    };
  }

  async start(): Promise<void> {
    if (this.started) return;
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

  async runScript({ script_id, subagent_id }: { script_id: string; subagent_id: string }): Promise<ExecutionResult> {
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
    });
    await this.rfa!.pushFile("/__queue.json", JSON.stringify(queue), "home");

    // Poll for the result file. Dispatcher writes it on completion.
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      await sleep(1_000);
      const content = await this.safeGetFile(resultPath);
      if (content) {
        try {
          const parsed = JSON.parse(content) as ExecutionResult;
          // Clean up the result file so the home fs doesn't grow.
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
      game_state_snapshot: await this.readState().catch(() => ({
        current_money: 0,
        bitnode_id: 1,
        bitnode_complete: false,
      })),
      timestamp: new Date().toISOString(),
    };
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
    return { current_money: 0, bitnode_id: 1, bitnode_complete: false };
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
    const execPath = this.opts.chromeExecutable ?? process.env.PUPPETEER_EXECUTABLE_PATH;
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
      .replace("__BENCHBURNER_SEED__", String(this.opts.seed))
      .replace("__BENCHBURNER_PORT__", String(this.rfaPortActual));
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
    const dispatcherSrc = readFileSync(path.join(HARNESS_GAME_SRC_DIR, "dispatcher.js"), "utf8");
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
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await sleep(500);
      const raw = await this.safeGetFile("/__state.json");
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as GameState;
          if (typeof parsed.current_money === "number") return;
        } catch {
          /* keep waiting */
        }
      }
    }
    throw new Error("dispatcher failed to produce /__state.json within 30s");
  }

  private async safeGetFile(filename: string): Promise<string | null> {
    try {
      const r = await this.rfa!.getFile(filename, "home");
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
