/** @param {NS} ns */
// Pushed into the game as /__dispatcher.js and run once at boot by the
// harness. Watches /__queue.json for tasks, runs each via ns.run, and
// writes /__results/<script_id>.json when the task exits. Also dumps
// /__state.json every tick so the harness can poll current money and
// bitnode without waiting for getSaveFile.
export async function main(ns) {
  ns.disableLog("ALL");
  const QUEUE = "/__queue.json";
  const STATE = "/__state.json";

  while (true) {
    // ── Publish state ────────────────────────────────────────────
    try {
      const p = ns.getPlayer();
      const ri = ns.getResetInfo();
      ns.write(
        STATE,
        JSON.stringify({
          current_money: Math.floor(p.money),
          bitnode_id: ri.currentNode,
          bitnode_complete: false,
          augments_installed: [],
          timestamp: new Date().toISOString(),
        }),
        "w",
      );
    } catch (_) {
      /* best effort */
    }

    // ── Process queue ────────────────────────────────────────────
    let queue = [];
    try {
      const raw = ns.read(QUEUE);
      queue = raw ? JSON.parse(raw) : [];
    } catch (_) {
      queue = [];
    }

    let changed = false;
    for (const task of queue) {
      if (task.status === "pending") {
        const startMoney = ns.getPlayer().money;
        const pid = ns.run(task.path, 1);
        if (pid > 0) {
          task.pid = pid;
          task.status = "running";
          task.startedAt = Date.now();
          task.startMoney = startMoney;
          changed = true;
        } else {
          task.status = "failed_to_start";
          task.error = "ns.run returned 0 (out of RAM or file missing?)";
          task.completedAt = Date.now();
          changed = true;
          // Emit the failure result so the harness unblocks.
          writeResult(ns, task, { failed: true });
        }
      } else if (task.status === "running") {
        if (!ns.isRunning(task.pid || 0)) {
          task.completedAt = Date.now();
          task.endMoney = ns.getPlayer().money;
          task.status = "done";
          changed = true;
          writeResult(ns, task, { failed: false });
        } else if (Date.now() - (task.startedAt || 0) > 120_000) {
          // Kill long-running scripts so one bad task doesn't block the queue.
          try {
            ns.kill(task.pid);
          } catch (_) {
            /* ignore */
          }
          task.status = "killed";
          task.completedAt = Date.now();
          task.error = "exceeded 120s runtime; killed";
          task.endMoney = ns.getPlayer().money;
          changed = true;
          writeResult(ns, task, { failed: true });
        }
      }
    }

    // Trim done/killed/failed_to_start entries to keep the file small.
    const kept = queue.filter((t) => t.status === "pending" || t.status === "running");
    if (kept.length !== queue.length) {
      queue = kept;
      changed = true;
    }

    if (changed) ns.write(QUEUE, JSON.stringify(queue), "w");

    await ns.sleep(500);
  }
}

function writeResult(ns, task, { failed }) {
  const ri = ns.getResetInfo();
  const elapsedSec = task.completedAt && task.startedAt ? (task.completedAt - task.startedAt) / 1000 : 0;
  const result = {
    script_id: task.script_id,
    subagent_id: task.subagent_id,
    status: failed ? "failed" : "executed",
    money_gained: (task.endMoney || 0) - (task.startMoney || 0),
    time_elapsed_seconds: elapsedSec,
    error: task.error,
    game_state_snapshot: {
      current_money: Math.floor(ns.getPlayer().money),
      bitnode_id: ri.currentNode,
      bitnode_complete: false,
      augments_installed: [],
    },
    timestamp: new Date().toISOString(),
  };
  ns.write(`/__results/${task.script_id}.json`, JSON.stringify(result), "w");
}
