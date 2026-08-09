/**
 * Drives `harness/game/dispatcher.js` itself against a fake `ns`.
 *
 * The dispatcher is plain Netscript pushed into the game, so nothing in
 * the normal gates executes it: a typo typechecks, and every rule it
 * enforces is validated only inside a browser running Bitburner. But it
 * is also an ordinary ES module whose only dependency is the `ns` object
 * it is handed — so a fake `ns` plus a sentinel thrown from `ns.sleep`
 * gets the real control flow under test without a browser.
 *
 * What that buys, and what `harness/game/eviction.ts`'s unit tests
 * cannot:
 *
 * - **Ordering.** Eviction must happen after `ns.run` returns a live pid.
 *   Killing first and then failing to start loses the income and gains
 *   nothing — the exact failure `replace` exists to prevent.
 * - **Kill.** `kill_requested` has no pure-function form to test; it is a
 *   branch in the running-task path.
 * - **Parity.** The eviction rule exists twice (here inline, there
 *   importable). These tests assert the copies agree.
 */
import { strict as assert } from "node:assert";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { describe } from "node:test";

import { evictionTargets, type QueueTask } from "../../harness/game/eviction";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DISPATCHER = pathToFileURL(
  path.resolve(HERE, "..", "..", "harness", "game", "dispatcher.js"),
).href;

const QUEUE = "/__queue.json";
const STATE = "/__state.json";

/** Thrown from the fake `ns.sleep` to break the dispatcher's while(true). */
class StopDispatcher extends Error {}

interface RunningScript {
  pid: number;
  onlineMoneyMade: number;
  onlineRunningTime: number;
  onlineExpGained: number;
  ramUsage: number;
  threads: number;
  logs: string[];
}

interface DispatchTask extends QueueTask {
  script_id?: string;
  path?: string;
  kill_requested?: boolean;
  startedAt?: number;
}

interface Harness {
  /** Ordered log of side effects, so ordering can be asserted. */
  events: Array<{ op: "run" | "kill"; path?: string; pid?: number }>;
  files: Map<string, string>;
  alive: Map<number, RunningScript>;
  queue(): DispatchTask[];
  result(script_id: string): Record<string, unknown> | null;
  state(): Record<string, unknown> | null;
}

interface RunOptions {
  queue: DispatchTask[];
  /** Already-running scripts, keyed by pid. */
  alive?: RunningScript[];
  /** pid `ns.run` hands back; 0 reproduces a RAM-budget refusal. */
  nextPid?: number;
  /** Dispatcher loop iterations to execute before stopping. */
  ticks?: number;
  money?: number;
}

function script(pid: number, over: Partial<RunningScript> = {}): RunningScript {
  return {
    pid,
    onlineMoneyMade: 0,
    onlineRunningTime: 0,
    onlineExpGained: 0,
    ramUsage: 2.4,
    threads: 1,
    logs: [],
    ...over,
  };
}

/**
 * Runs the real dispatcher for `ticks` iterations and returns everything
 * it touched.
 */
async function runDispatcher(opts: RunOptions): Promise<Harness> {
  const files = new Map<string, string>();
  files.set(QUEUE, JSON.stringify(opts.queue));
  const alive = new Map<number, RunningScript>();
  for (const s of opts.alive ?? []) alive.set(s.pid, s);

  const events: Harness["events"] = [];
  const ticks = opts.ticks ?? 1;
  let tick = 0;
  let nextPid = opts.nextPid ?? 500;

  const ns = {
    disableLog: () => {},
    tprint: () => {},
    print: () => {},
    getServerMoneyAvailable: (_host: string) => opts.money ?? 1262,
    read: (file: string) => files.get(file) ?? "",
    write: (file: string, data: string, _mode: string) => {
      files.set(file, data);
    },
    run: (file: string, _threads: number) => {
      events.push({ op: "run", path: file });
      if (nextPid === 0) return 0;
      const pid = nextPid;
      nextPid += 1;
      alive.set(pid, script(pid));
      return pid;
    },
    isRunning: (pid: number) => alive.has(pid),
    kill: (pid: number) => {
      events.push({ op: "kill", pid });
      // ns.kill throws on a pid that is not running; the dispatcher has
      // to survive that, so the fake reproduces it rather than being
      // politely permissive.
      if (!alive.has(pid)) throw new Error(`no script with pid ${pid}`);
      alive.delete(pid);
      return true;
    },
    getRunningScript: (pid: number) => alive.get(pid) ?? null,
    getRecentScripts: () => [],
    sleep: async (_ms: number) => {
      tick += 1;
      if (tick >= ticks) throw new StopDispatcher();
      return true;
    },
  };

  const mod = (await import(DISPATCHER)) as {
    main: (n: typeof ns) => Promise<void>;
  };
  try {
    await mod.main(ns);
    assert.fail("dispatcher returned instead of looping");
  } catch (e) {
    if (!(e instanceof StopDispatcher)) throw e;
  }

  const parse = (raw: string | undefined): unknown => {
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };

  return {
    events,
    files,
    alive,
    queue: () => (parse(files.get(QUEUE)) as DispatchTask[]) ?? [],
    result: (script_id: string) =>
      parse(files.get(`/__results/${script_id}.json`)) as Record<string, unknown> | null,
    state: () => parse(files.get(STATE)) as Record<string, unknown> | null,
  };
}

const committed = (over: Partial<DispatchTask>): DispatchTask => ({
  kind: "committed",
  ...over,
});

const earner = (subagent_id: string, pid: number, script_id = `s-${pid}`): DispatchTask =>
  committed({ script_id, subagent_id, pid, status: "running", path: `/__scripts/${script_id}.js` });

const pending = (subagent_id: string, script_id: string, replace?: boolean): DispatchTask =>
  committed({
    script_id,
    subagent_id,
    status: "pending",
    path: `/__scripts/${script_id}.js`,
    ...(replace === undefined ? {} : { replace }),
  });

/** pids the dispatcher actually killed, in order. */
const killed = (h: Harness): number[] =>
  h.events.filter((e) => e.op === "kill").map((e) => e.pid as number);

describe("dispatcher — committed-script replacement", () => {
  test("replace omitted leaves the running earner alone", async () => {
    const old = earner("a", 101, "old");
    const h = await runDispatcher({ queue: [old, pending("a", "new")], alive: [script(101)] });

    assert.deepEqual(killed(h), [], "the predecessor must survive an ordinary commit");
    assert.ok(h.alive.has(101), "the earner is still running in-game");
    assert.equal(h.result("old"), null, "no eviction result was written");
    const still = h.queue().find((t) => t.script_id === "old");
    assert.equal(still?.status, "running", "the predecessor stays in the queue as running");
  });

  test("replace true evicts the predecessor — but only after the replacement started", async () => {
    const h = await runDispatcher({
      queue: [earner("a", 101, "old"), pending("a", "new", true)],
      alive: [script(101)],
      nextPid: 202,
    });

    assert.deepEqual(killed(h), [101]);
    assert.equal(h.alive.has(101), false, "the predecessor is stopped");
    assert.ok(h.alive.has(202), "the replacement is running");

    const runAt = h.events.findIndex((e) => e.op === "run");
    const killAt = h.events.findIndex((e) => e.op === "kill");
    assert.ok(runAt >= 0 && killAt >= 0);
    assert.ok(
      runAt < killAt,
      `eviction must follow a confirmed start (run at ${runAt}, kill at ${killAt})`,
    );

    const res = h.result("old");
    assert.equal(res?.exit_reason, "replaced");
    assert.match(String(res?.stderr), /replaced by a newer committed script/);
  });

  test("a replacement that fails to start keeps the predecessor, and reports failed_to_start", async () => {
    // nextPid 0 is ns.run refusing the script — the RAM-budget failure
    // this whole change makes the orchestrator's loud, visible one.
    const h = await runDispatcher({
      queue: [earner("a", 101, "old"), pending("a", "new", true)],
      alive: [script(101)],
      nextPid: 0,
    });

    assert.deepEqual(killed(h), [], "income must not be spent on a start that never happened");
    assert.ok(h.alive.has(101), "the earner is still running");
    assert.equal(h.result("old"), null);

    const res = h.result("new");
    assert.equal(res?.exit_reason, "failed_to_start");
    assert.equal(res?.status, "failed");
    assert.match(String(res?.stderr), /RAM budget exceeded/);
  });

  test("replace true does not touch another subagent's script", async () => {
    const h = await runDispatcher({
      queue: [earner("a", 101, "mine"), earner("b", 102, "theirs"), pending("a", "new", true)],
      alive: [script(101), script(102)],
    });

    assert.deepEqual(killed(h), [101]);
    assert.ok(h.alive.has(102), "another subagent's earner is not this instruction's to kill");
  });

  test("probes are never evicted", async () => {
    const probe: DispatchTask = {
      script_id: "probe",
      subagent_id: "a",
      pid: 101,
      status: "running",
      kind: "probe",
      path: "/__scripts/probe.js",
      // Freshly started: probes are killed at 120 s, and a fixture
      // without startedAt trips that timeout rather than the rule
      // under test.
      startedAt: Date.now(),
    };
    const h = await runDispatcher({
      queue: [probe, pending("a", "new", true)],
      alive: [script(101)],
    });

    assert.deepEqual(killed(h), [], "a probe never occupies the committed slot");
  });

  test("the inline rule agrees with harness/game/eviction.ts", async () => {
    // The rule exists twice by necessity. This is what catches a
    // divergence: same queue, same answer.
    const cases: DispatchTask[][] = [
      [earner("a", 101, "old"), pending("a", "new")],
      [earner("a", 101, "old"), pending("a", "new", false)],
      [earner("a", 101, "old"), pending("a", "new", true)],
      [earner("a", 101, "mine"), earner("b", 102, "theirs"), pending("a", "new", true)],
      [earner("A", 101, "upper"), pending("a", "new", true)],
    ];
    for (const queue of cases) {
      const incoming = queue[queue.length - 1];
      const expected = evictionTargets(queue, incoming).map((t) => t.pid);
      const h = await runDispatcher({
        queue,
        alive: queue.filter((t) => t.status === "running").map((t) => script(t.pid as number)),
      });
      assert.deepEqual(
        killed(h),
        expected,
        `inline dispatcher rule diverged from evictionTargets for ${JSON.stringify(queue)}`,
      );
    }
  });
});

describe("dispatcher — per-subagent live script stats", () => {
  test("the state export attributes earnings to the subagent that owns the script", async () => {
    const h = await runDispatcher({
      queue: [earner("a", 101, "mine"), earner("b", 102, "theirs")],
      alive: [
        script(101, { onlineMoneyMade: 45000, onlineRunningTime: 180, ramUsage: 2.6 }),
        script(102, { onlineMoneyMade: 7, onlineRunningTime: 12, ramUsage: 1.7 }),
      ],
    });

    const live = h.state()?.live_scripts as Record<string, Record<string, unknown>>;
    assert.ok(live, "/__state.json must carry live_scripts");
    assert.deepEqual(live.a, { running: true, money_made: 45000, ram: 2.6, uptime_seconds: 180 });
    assert.equal(live.b.money_made, 7, "each script's own earnings, not a shared player delta");
  });

  test("a committed script whose process is gone reports running: false", async () => {
    // The task still says "running" in the queue but ns.getRunningScript
    // has nothing — an earner that died is exactly the case the
    // orchestrator was blind to.
    const h = await runDispatcher({ queue: [earner("a", 101, "dead")], alive: [] });

    const live = h.state()?.live_scripts as Record<string, Record<string, unknown>>;
    assert.equal(live.a.running, false);
    assert.equal(live.a.money_made, 0);
  });

  test("probes and pending tasks are not reported as live committed scripts", async () => {
    const probe: DispatchTask = {
      script_id: "probe",
      subagent_id: "p",
      pid: 103,
      status: "running",
      kind: "probe",
      path: "/__scripts/probe.js",
      startedAt: Date.now(),
    };
    const h = await runDispatcher({
      queue: [probe, pending("q", "queued")],
      alive: [script(103, { onlineMoneyMade: 5 })],
    });

    const live = h.state()?.live_scripts as Record<string, unknown>;
    assert.deepEqual(Object.keys(live), [], "only running committed scripts belong here");
  });

  test("the state export still carries the fields the harness polls", async () => {
    const h = await runDispatcher({ queue: [], money: 4242 });
    const s = h.state();
    assert.equal(s?.current_money, 4242);
    assert.equal(typeof s?.last_heartbeat_ms, "number");
    assert.equal(typeof s?.timestamp, "string");
  });
});

describe("dispatcher — kill requests", () => {
  test("kill_requested stops the script and leaves no orphan", async () => {
    const target = earner("a", 101, "doomed");
    target.kill_requested = true;
    const h = await runDispatcher({ queue: [target], alive: [script(101)] });

    assert.deepEqual(killed(h), [101], "the killed subagent's script must actually stop");
    assert.equal(h.alive.has(101), false, "no orphan keeps burning RAM and earning invisibly");

    const res = h.result("doomed");
    assert.equal(res?.exit_reason, "killed");
    assert.match(String(res?.stderr), /orchestrator killed its subagent/);

    assert.equal(
      h.queue().find((t) => t.script_id === "doomed"),
      undefined,
      "the finished task is trimmed out of the queue",
    );
  });

  test("kill_requested on one subagent leaves the others running", async () => {
    const target = earner("a", 101, "doomed");
    target.kill_requested = true;
    const h = await runDispatcher({
      queue: [target, earner("b", 102, "survivor")],
      alive: [script(101), script(102)],
    });

    assert.deepEqual(killed(h), [101]);
    assert.ok(h.alive.has(102));
  });

  test("a kill request on an already-dead script still resolves the task", async () => {
    // ns.kill throws on an unknown pid in-game; the task must still be
    // closed out rather than being retried every 500 ms forever.
    const target = earner("a", 999, "gone");
    target.kill_requested = true;
    const h = await runDispatcher({ queue: [target], alive: [] });

    assert.equal(h.result("gone")?.exit_reason, "killed");
    assert.equal(h.queue().length, 0);
  });
});
