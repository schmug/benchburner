/**
 * SnapshotTimer — fires at the top of every wall-clock hour of the
 * run. Pulls distilled game state via the game controller, publishes
 * a `snapshots` message, and records to storage.
 *
 * SPEC §2.4. Uses a setTimeout chain keyed off run start so there's
 * no interval drift.
 */

import { randomUUID } from "node:crypto";

import type { Bus } from "../bus/bus";
import type { Db } from "../storage/db";
import { insertSnapshot } from "../storage/writers";
import type { GameController, Snapshot } from "../types";

export interface SnapshotTimerOptions {
  run_id: string;
  startTime: number; // Date.now() at run start
  durationHours: number;
  intervalSeconds?: number; // overrideable for tests; default 3600
  game: GameController;
  bus: Bus;
  db: Db;
}

export class SnapshotTimer {
  private readonly opts: SnapshotTimerOptions;
  private readonly intervalSeconds: number;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private hour = 0;
  private capturedHour0 = false;

  constructor(opts: SnapshotTimerOptions) {
    this.opts = opts;
    this.intervalSeconds = opts.intervalSeconds ?? 3600;
  }

  async start(): Promise<void> {
    if (this.stopped) return;
    // Hour 0 snapshot immediately — orchestrator's first cycle needs
    // initial state to reason over.
    await this.capture(0);
    this.capturedHour0 = true;
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(): void {
    if (this.stopped) return;
    this.hour += 1;
    if (this.hour > this.opts.durationHours) return;
    const nextFireAt = this.opts.startTime + this.hour * this.intervalSeconds * 1000;
    const delay = Math.max(0, nextFireAt - Date.now());
    this.timer = setTimeout(() => {
      void this.capture(this.hour).finally(() => this.schedule());
    }, delay);
  }

  private async capture(hour: number): Promise<void> {
    try {
      const game_state = await this.opts.game.readState();
      const snapshot_id = randomUUID();
      const timestamp = new Date().toISOString();
      insertSnapshot(this.opts.db, {
        snapshot_id,
        run_id: this.opts.run_id,
        hour,
        game_state,
        timestamp,
      });
      const msg: Snapshot = {
        source: "backend_snapshot",
        hour,
        game_state,
        timestamp,
      };
      this.opts.bus.publish("snapshots", msg);
      console.log(`[snapshot] hour ${hour}: money=${game_state.current_money}`);
    } catch (e) {
      console.error(`[snapshot] hour ${hour} failed:`, (e as Error).message);
    }
  }

  /** Test hook. */
  __isHour0Captured(): boolean {
    return this.capturedHour0;
  }
}
