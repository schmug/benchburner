#!/usr/bin/env node
/**
 * VALIDATION.md PAS3: subagent agentic iteration-counter sanity.
 *
 * Constructs a SubagentWorker wired to:
 *   - TestScriptedAdapter: emits {RUN, RUN, DONE} in order
 *   - MockGame: stands in for the game controller's probe execution
 *
 * Publishes one Instruction and waits for a Result. Asserts the result
 * shows iterations=3 (or fewer if maxIterations bounds earlier),
 * iteration_summaries.length matches the number of RUN turns that ran,
 * and each summary reflects a distinct probe execution.
 *
 * Exits 0 on pass, 1 on fail.
 */
import { Bus } from "../harness/bus/bus.ts";
import { MockGame } from "../harness/game/mock.ts";
import { InferenceRegistry } from "../harness/inference/registry.ts";
import { SubagentPool, SubagentWorker } from "../harness/subagent/index.ts";

const registry = new InferenceRegistry([
  {
    id: "test-scripted",
    adapter: "test-scripted",
    endpoint: "none",
    context_window: 8192,
  },
]);

const bus = new Bus();
const pool = new SubagentPool();
const game = new MockGame({ seed: 8675309 });
await game.start();

const worker = new SubagentWorker({
  bus,
  registry,
  pool,
  limits: {
    max_concurrent: 1,
    token_budget_per_instruction: 200,
    timeout_seconds: 10,
  },
  game,
});
worker.start();

const subagentId = "test-subagent-1";
pool.spawn(subagentId, "test-scripted", new Date().toISOString());

// Listen for the result the worker will publish.
const resultPromise = new Promise((resolve, reject) => {
  const unsub = bus.subscribe("results", (r) => {
    unsub();
    resolve(r);
  });
  setTimeout(() => reject(new Error("PAS3: timed out waiting for Result")), 30_000);
});

bus.publish("instructions", {
  instruction_id: "test-inst-1",
  subagent_id: subagentId,
  task: "test task",
  context: "",
  constraints: { token_budget: 200, max_script_size_lines: 30 },
  timestamp: new Date().toISOString(),
});

const result = await resultPromise;
await worker.stop();
await game.stop();

const assertions = [];
const assert = (cond, msg) => {
  assertions.push({ cond, msg });
  if (!cond) console.error(`  ✗ ${msg}`);
  else console.log(`  ✓ ${msg}`);
};

console.log("--- PAS3 assertions ---");
assert(result.status === "success", `result.status == "success" (got "${result.status}")`);
assert(result.iterations === 3, `result.iterations == 3 — subagent committed on the 3rd turn after 2 RUN probes (got ${result.iterations})`);
assert(
  Array.isArray(result.iteration_summaries) && result.iteration_summaries.length === 2,
  `iteration_summaries.length == 2 — one entry per RUN turn (got ${result.iteration_summaries?.length})`,
);
if (Array.isArray(result.iteration_summaries)) {
  assert(
    result.iteration_summaries[0]?.iteration === 1 && result.iteration_summaries[1]?.iteration === 2,
    `iteration numbers are [1, 2] in order`,
  );
  const moneys = result.iteration_summaries.map((s) => s.money_gained);
  assert(
    moneys.every((m) => typeof m === "number"),
    `each summary has a numeric money_gained (got ${JSON.stringify(moneys)})`,
  );
}
assert(typeof result.code === "string" && result.code.includes("final"), `final committed code comes from the DONE turn (contains 'final')`);

const passed = assertions.filter((a) => a.cond).length;
const total = assertions.length;
console.log(`\n${passed}/${total} assertions passed.`);
process.exit(passed === total ? 0 : 1);
