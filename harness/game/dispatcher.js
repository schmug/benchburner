/** @param {NS} ns */
// Pushed into the game as /__dispatcher.js and run once at boot by the
// harness. Watches /__queue.json for tasks, runs each via ns.run, and
// writes /__results/<script_id>.json when the task exits. Captures the
// task's log (ns.print / ns.tprint output), kill reason, exp, and ram
// usage so the orchestrator has normal dev-loop feedback. Also dumps
// /__state.json every tick so the harness can poll current money
// without waiting for getSaveFile.
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
          task.status = "done";
          task.completedAt = Date.now();
          task.exit_reason = "failed_to_start";
          task.stderr = "ns.run returned 0 — script missing or RAM budget exceeded";
          task.endMoney = startMoney;
          changed = true;
          writeResult(ns, task);
        }
      } else if (task.status === "running") {
        const stillRunning = ns.isRunning(task.pid || 0);
        const timeOut = Date.now() - (task.startedAt || 0) > 120_000;
        if (!stillRunning || timeOut) {
          // Capture runtime info BEFORE killing (if timeout) so we can
          // include the tail log in the result.
          let stats = null;
          try {
            stats = ns.getRunningScript(task.pid);
          } catch (_) {
            stats = null;
          }
          if (timeOut && stillRunning) {
            try {
              ns.kill(task.pid);
            } catch (_) {
              /* ignore */
            }
            task.exit_reason = "timed_out";
            task.stderr = "exceeded 120s runtime; killed by dispatcher";
          } else {
            task.exit_reason = stats ? "exited" : "errored";
          }
          task.completedAt = Date.now();
          task.endMoney = ns.getPlayer().money;

          // Tail log (ns.print / ns.tprint buffer) — truncate to keep
          // the result file manageable.
          if (stats && Array.isArray(stats.logs)) {
            const joined = stats.logs.join("\n");
            task.stdout = joined.length > 8000 ? joined.slice(-8000) : joined;
          }
          if (stats) {
            task.script_stats = {
              online_running_time_seconds: stats.onlineRunningTime ?? 0,
              online_exp_gained: stats.onlineExpGained ?? 0,
              online_money_made: stats.onlineMoneyMade ?? 0,
              ram_usage: stats.ramUsage ?? 0,
              threads: stats.threads ?? 1,
            };
          }

          task.status = "done";
          changed = true;
          writeResult(ns, task);
        }
      }
    }

    // Trim done entries to keep the file small.
    const kept = queue.filter((t) => t.status === "pending" || t.status === "running");
    if (kept.length !== queue.length) {
      queue = kept;
      changed = true;
    }

    if (changed) ns.write(QUEUE, JSON.stringify(queue), "w");

    await ns.sleep(500);
  }
}

function writeResult(ns, task) {
  const ri = ns.getResetInfo();
  const elapsedSec =
    task.completedAt && task.startedAt ? (task.completedAt - task.startedAt) / 1000 : 0;
  const failed = task.exit_reason && task.exit_reason !== "exited";
  const result = {
    script_id: task.script_id,
    subagent_id: task.subagent_id,
    status: failed ? "failed" : "executed",
    money_gained: (task.endMoney || 0) - (task.startMoney || 0),
    time_elapsed_seconds: elapsedSec,
    error: task.stderr,
    stdout: task.stdout,
    stderr: task.stderr,
    exit_reason: task.exit_reason,
    script_stats: task.script_stats,
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
