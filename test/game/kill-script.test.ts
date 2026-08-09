/**
 * PuppeteerGame.killScript is the write half of the kill mechanism: it
 * flags this subagent's committed queue entries with `kill_requested`
 * and pushes the whole queue back for the dispatcher's next tick. Until
 * now only the target-selection rule (`killTargets`) was unit-tested;
 * the method around it — read /__queue.json, flag, write back, and the
 * no-op paths — was verified in-game by hand.
 *
 * Booting Chromium in `npm test` is not viable, so the game boundary is
 * a fake RFA injected past the private fields, and the assertions are on
 * what gets written back through it.
 */
import { strict as assert } from "node:assert";
import test, { describe } from "node:test";

import type { QueueTask } from "../../harness/game/eviction";
import { PuppeteerGame } from "../../harness/game/puppeteer";

const SUB = "worker-1";

interface FakeRfa {
  isConnected(): boolean;
  getFile(filename: string, server?: string): Promise<string | null>;
  pushFile(filename: string, content: string, server?: string): Promise<void>;
}

/** A PuppeteerGame wired to an in-memory queue file instead of a browser. */
function gameWithQueue(queue: QueueTask[] | null): {
  game: PuppeteerGame;
  writes: Array<{ filename: string; content: string }>;
} {
  const writes: Array<{ filename: string; content: string }> = [];
  const rfa: FakeRfa = {
    isConnected: () => true,
    getFile: async (filename) =>
      filename === "/__queue.json" && queue !== null ? JSON.stringify(queue) : null,
    pushFile: async (filename, content) => {
      writes.push({ filename, content });
    },
  };
  const game = new PuppeteerGame({ seed: 1 });
  (game as unknown as { rfa: FakeRfa; started: boolean }).rfa = rfa;
  (game as unknown as { started: boolean }).started = true;
  return { game, writes };
}

function task(over: Partial<QueueTask> = {}): QueueTask {
  return { subagent_id: SUB, kind: "committed", status: "running", pid: 7, ...over };
}

describe("PuppeteerGame.killScript", () => {
  test("flags the subagent's running and pending committed entries and writes the queue back", async () => {
    // Pending included deliberately: a committed entry is at most one
    // dispatcher tick from ns.run, and skipping it recreates the orphan
    // kill exists to prevent.
    const mine = task();
    const minePending = task({ status: "pending", pid: undefined });
    const otherSub = task({ subagent_id: "worker-2" });
    const myProbe = task({ kind: "probe" });
    const { game, writes } = gameWithQueue([mine, minePending, otherSub, myProbe]);

    await game.killScript(SUB);

    assert.equal(writes.length, 1, "one queue write-back");
    assert.equal(writes[0].filename, "/__queue.json");
    const written = JSON.parse(writes[0].content) as QueueTask[];
    assert.equal(written.length, 4, "the whole queue survives the write-back, not just targets");
    const flagged = written.filter((t) => t.kill_requested === true);
    assert.deepEqual(
      flagged.map((t) => [t.subagent_id, t.status]),
      [
        [SUB, "running"],
        [SUB, "pending"],
      ],
      "exactly the subagent's own committed entries are flagged",
    );
  });

  test("does not write when the subagent has nothing committed in the queue", async () => {
    const { game, writes } = gameWithQueue([task({ subagent_id: "worker-2" }), task({ kind: "probe" })]);
    await game.killScript(SUB);
    assert.deepEqual(writes, [], "a no-target kill must not touch /__queue.json");
  });

  test("does not write when the queue file is missing", async () => {
    const { game, writes } = gameWithQueue(null);
    await game.killScript(SUB);
    assert.deepEqual(writes, []);
  });

  test("refuses to run before start() has completed", async () => {
    const game = new PuppeteerGame({ seed: 1 });
    await assert.rejects(() => game.killScript(SUB), /start\(\) has not completed/);
  });
});
