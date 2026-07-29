/**
 * SnapshotTimer — fires at a fixed cadence across the run. Pulls
 * distilled game state via the game controller, publishes a
 * `snapshots` message, and records to storage.
 *
 * SPEC §2.4. Uses a setTimeout chain keyed off run start so there's
 * no interval drift.
 *
 * The cadence used to be hardcoded at one hour, which was correct for
 * the 24h run the SPEC was written against but silently degraded the
 * canonical 20-minute run to a single hour-0 snapshot — removing one
 * of the two information channels CLAUDE.md constraint #3 grants the
 * orchestrator. The interval is now proportional to run duration, so
 * a run of any length yields the same SNAPSHOTS_PER_RUN coverage that
 * a 24h run always had.
 */

import { randomUUID } from "node:crypto";

import type { Bus } from "../bus/bus";
import type { Db } from "../storage/db";
import { insertSnapshot } from "../storage/writers";
import type { GameController, Snapshot } from "../types";

/**
 * Snapshots taken per run, whatever its length. 24 is not arbitrary:
 * it is what a 24h run produced under the old hardcoded hourly
 * cadence, so 24h runs are bit-identical across this change and the
 * existing artifacts stay comparable.
 */
export const SNAPSHOTS_PER_RUN = 24;

/**
 * Floor on the cadence. A short smoke run (e.g. 120s) would otherwise
 * poll the game controller every 5s, which is heavier than readState
 * should be driven. Trades snapshot count for host stability.
 */
export const MIN_SNAPSHOT_INTERVAL_SECONDS = 30;

/**
 * Resolves the snapshot cadence for a run. Explicit config wins;
 * otherwise the interval is proportional to duration, floored for very
 * short runs but never past the end of the run itself (a first
 * interval beyond run-end would regress to hour-0-only).
 */
export function resolveSnapshotInterval(durationSeconds: number, override?: number): number {
  if (override !== undefined) return override;
  const proportional = durationSeconds / SNAPSHOTS_PER_RUN;
  return Math.min(durationSeconds, Math.max(MIN_SNAPSHOT_INTERVAL_SECONDS, proportional));
}

export interface SnapshotTimerOptions {
  run_id: string;
  startTime: number; // Date.now() at run start
  durationSeconds: number;
  /** Overrides the proportional default; see resolveSnapshotInterval. */
  intervalSeconds?: number;
  game: GameController;
  bus: Bus;
  db: Db;
}

export class SnapshotTimer {
  private readonly opts: SnapshotTimerOptions;
  private readonly intervalSeconds: number;
  private readonly totalSnapshots: number;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  /**
   * Snapshot index, not a wall-clock hour — it only coincided with one
   * back when the cadence was hardcoded hourly. Named `hour` because
   * the storage column and the Snapshot message field are both `hour`;
   * renaming those would invalidate existing run artifacts.
   */
  private hour = 0;
  private capturedHour0 = false;

  constructor(opts: SnapshotTimerOptions) {
    this.opts = opts;
    this.intervalSeconds = resolveSnapshotInterval(opts.durationSeconds, opts.intervalSeconds);
    this.totalSnapshots = Math.ceil(opts.durationSeconds / this.intervalSeconds);
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
    if (this.hour > this.totalSnapshots) return;
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
