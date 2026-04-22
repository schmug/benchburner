/**
 * Typed in-memory pub/sub for the harness.
 *
 * Contract:
 * - Handlers are invoked synchronously, in subscription order.
 * - Handler exceptions are logged to console.error; other handlers still run.
 * - After freeze(), publish() is a silent no-op. Subscriptions are untouched.
 * - No persistence, no replay, no cross-channel ordering guarantees beyond
 *   single-channel insertion order.
 *
 * See harness/bus/README.md for channel roles and design notes.
 */

import type { ChannelMap } from "../types";

type Handler<T> = (msg: T) => void;
type Channel = keyof ChannelMap;

type HandlerMap = { [K in Channel]?: Array<Handler<ChannelMap[K]>> };
type StatsMap = Record<Channel, { subscribers: number; published: number }>;

const CHANNELS: Channel[] = ["instructions", "results", "executions", "snapshots"];

export class Bus {
  private handlers: HandlerMap = {};
  private publishedCounts: Record<Channel, number> = {
    instructions: 0,
    results: 0,
    executions: 0,
    snapshots: 0,
  };
  private frozen = false;

  /**
   * Publish a message on the given channel. Handlers run synchronously
   * in the order they subscribed. Throws from handlers are caught and
   * logged so one bad consumer cannot knock out the rest.
   *
   * Publishes on a frozen bus are silently dropped so shutdown paths
   * (which may race with in-flight producers) can be idempotent.
   */
  publish<K extends Channel>(channel: K, msg: ChannelMap[K]): void {
    if (this.frozen) return;
    this.publishedCounts[channel] += 1;
    const list = this.handlers[channel];
    if (!list || list.length === 0) return;
    // Snapshot so that unsubscribes during delivery don't reindex the live array.
    const snapshot = list.slice();
    for (const handler of snapshot) {
      try {
        handler(msg);
      } catch (err) {
        console.error(`[bus] handler threw on channel="${channel}":`, err);
      }
    }
  }

  /**
   * Subscribe to a channel. Returns an unsubscribe function that removes
   * exactly this handler registration (safe to call more than once).
   */
  subscribe<K extends Channel>(
    channel: K,
    handler: Handler<ChannelMap[K]>,
  ): () => void {
    let list = this.handlers[channel] as Array<Handler<ChannelMap[K]>> | undefined;
    if (!list) {
      list = [];
      // Typed-index assignment: the conditional map type makes this the
      // cleanest way to persist the per-channel array.
      (this.handlers as HandlerMap)[channel] = list as HandlerMap[K];
    }
    list.push(handler);

    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const current = this.handlers[channel] as
        | Array<Handler<ChannelMap[K]>>
        | undefined;
      if (!current) return;
      const idx = current.indexOf(handler);
      if (idx !== -1) current.splice(idx, 1);
    };
  }

  /**
   * Stop accepting new publishes. Existing subscriptions remain so that
   * drain-in-flight logic (e.g. a storage handler flushing the last
   * message it already received) still works.
   */
  freeze(): void {
    this.frozen = true;
  }

  /** Debug view: subscriber counts and lifetime publish counts per channel. */
  stats(): StatsMap {
    const out = {} as StatsMap;
    for (const channel of CHANNELS) {
      const list = this.handlers[channel];
      out[channel] = {
        subscribers: list ? list.length : 0,
        published: this.publishedCounts[channel],
      };
    }
    return out;
  }
}
