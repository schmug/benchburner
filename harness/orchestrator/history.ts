/**
 * Delegation history compression for the orchestrator input.
 *
 * Policy (per HANDOFF.md §"Key Decisions" + CLAUDE.md §"Decisions"):
 *   - Keep the last N cycles verbatim (default 10).
 *   - Everything older is folded into a rolling summary that the
 *     orchestrator itself generates, piggybacked on its normal calls.
 *
 * This module owns only the "trim to last N" and "replace older with
 * a summary string" mechanics. The summary generation itself lives in
 * the loop, because it calls the orchestrator model.
 */

import type { Instruction, Result } from "../types";

export interface HistoryEntry {
  cycle_number: number;
  instruction: Instruction;
  result: Result | null;
}

export class HistoryBuffer {
  private readonly entries: HistoryEntry[] = [];
  /** Rolling summary of all entries older than the verbatim window. */
  private summary: string = "";
  /** Tracks which cycle the summary covers up to (inclusive). */
  private summarizedThrough: number = -1;

  constructor(private readonly window: number) {}

  record(entry: HistoryEntry): void {
    this.entries.push(entry);
  }

  /**
   * Returns { verbatim, summary } where `verbatim` is the last N
   * entries (chronological) and `summary` covers everything older.
   */
  view(): { verbatim: Array<{ instruction: Instruction; result: Result | null }>; summary: string | undefined } {
    const verbatimEntries = this.entries.slice(-this.window);
    const verbatim = verbatimEntries.map((e) => ({ instruction: e.instruction, result: e.result }));
    return { verbatim, summary: this.summary || undefined };
  }

  /**
   * Entries that should be folded into the rolling summary but aren't
   * yet. The loop passes these to the orchestrator model with a
   * "summarize the following older cycles" directive.
   */
  pendingSummaryEntries(): HistoryEntry[] {
    const cutoffIndex = this.entries.length - this.window;
    if (cutoffIndex <= 0) return [];
    return this.entries.slice(0, cutoffIndex).filter((e) => e.cycle_number > this.summarizedThrough);
  }

  recordSummary(summary: string, throughCycle: number): void {
    this.summary = summary;
    this.summarizedThrough = throughCycle;
  }
}
