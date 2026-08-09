/**
 * Dev-only MockGame implementation of GameController.
 *
 * Lets modules (bus, storage, orchestrator, subagent) run end-to-end
 * without a real Bitburner instance. Deterministic given the same seed
 * and call sequence, so smoke tests can assert expected values.
 *
 * NOT used for scored benchmark runs — those must use the real
 * Puppeteer + Remote File API controller (Phase 4). The mock's RNG is
 * a local-only dev aid; the real-run seed is injected via a fork patch
 * and kept opaque to the orchestrator per CLAUDE.md § "Core Constraints" #6.
 */

import type {
  ExecutionResult,
  GameController,
  GameState,
} from "../types.ts";

export interface MockGameOptions {
  /** Seed used for deterministic per-script money. Not leaked; this is dev only. */
  seed?: number;
  /**
   * Called each time the mock "advances time" so tests can assert timing.
   * Default: no-op.
   */
  onAdvance?(ms: number): void;
}

// ── Deterministic PRNG (xmur3 + mulberry32) ────────────────────────
// Same family Bitburner itself uses (SFC32RNG). Inline so we keep the
// mock dependency-free.

function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STARTING_MONEY = 1000; // Bitburner player-start.
const FAIL_RATE = 0.05;

export class MockGame implements GameController {
  private readonly onAdvance: (ms: number) => void;
  private readonly rand: () => number;
  private readonly scripts = new Map<string, string>();
  private money = STARTING_MONEY;
  private started = false;
  private stopped = false;

  constructor(opts: MockGameOptions = {}) {
    this.onAdvance = opts.onAdvance ?? (() => {});
    const seed = opts.seed ?? 0xbadc0de;
    // Stir the seed through xmur3 so adjacent seeds produce
    // meaningfully different streams.
    const stir = xmur3(String(seed));
    this.rand = mulberry32(stir());
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error("MockGame: cannot start after stop()");
    this.started = true;
  }

  async submitScript(p: { script_id: string; code: string }): Promise<void> {
    this.requireLive("submitScript");
    if (this.scripts.has(p.script_id)) {
      throw new Error(`MockGame: script_id "${p.script_id}" already submitted`);
    }
    this.scripts.set(p.script_id, p.code);
  }

  async runScript(p: {
    script_id: string;
    subagent_id: string;
  }): Promise<ExecutionResult> {
    this.requireLive("runScript");
    if (!this.scripts.has(p.script_id)) {
      throw new Error(`MockGame: unknown script_id "${p.script_id}"`);
    }

    // Time elapsed: 5-60 seconds.
    const timeElapsed = 5 + Math.floor(this.rand() * 56);
    this.onAdvance(timeElapsed * 1000);

    // Deterministic failure coin flip.
    const failed = this.rand() < FAIL_RATE;
    const now = new Date().toISOString();

    if (failed) {
      return {
        script_id: p.script_id,
        subagent_id: p.subagent_id,
        status: "failed",
        money_gained: 0,
        time_elapsed_seconds: timeElapsed,
        error: "simulated runtime error: script crashed (mock)",
        game_state_snapshot: this.snapshotState(),
        timestamp: now,
      };
    }

    // Money gained: small-but-growing amount, shaped so early scripts
    // earn modestly (hacking n00dles-style) and later ones can spike.
    // Range is roughly [100, 1_000_000] with a log-uniform feel.
    const r = this.rand();
    const moneyGained = Math.floor(100 * Math.pow(10_000, r));
    this.money += moneyGained;

    return {
      script_id: p.script_id,
      subagent_id: p.subagent_id,
      status: "executed",
      money_gained: moneyGained,
      time_elapsed_seconds: timeElapsed,
      game_state_snapshot: this.snapshotState(),
      timestamp: now,
    };
  }

  async killScript(_subagent_id: string): Promise<void> {
    // MockGame has no in-game process: runScript resolves synchronously
    // with a simulated outcome, so nothing outlives the call and there is
    // nothing to stop. Present because GameController requires it.
  }

  async readState(): Promise<GameState> {
    // readState is safe even after stop() — reflects frozen final state.
    if (!this.started) {
      throw new Error("MockGame: readState() called before start()");
    }
    return this.snapshotState();
  }

  async stop(): Promise<void> {
    // Idempotent; further calls no-op.
    this.stopped = true;
  }

  // ── internals ──────────────────────────────────────────────────────

  private snapshotState(): GameState {
    // Unlike PuppeteerGame there is no baseline to capture: the mock
    // knows its starting balance at construction.
    return {
      current_money: this.money,
      starting_money: STARTING_MONEY,
      money_earned: this.money - STARTING_MONEY,
      bitnode_id: 1,
      bitnode_complete: false,
      augments_installed: [],
    };
  }

  private requireLive(op: string): void {
    if (!this.started) {
      throw new Error(`MockGame: ${op}() called before start()`);
    }
    if (this.stopped) {
      throw new Error(`MockGame: ${op}() called after stop()`);
    }
  }
}
