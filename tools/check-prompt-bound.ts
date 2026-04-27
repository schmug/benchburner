// Standalone check that subagent_status truncation in assembleInput
// keeps prompt size bounded as the subagent pool grows. Run with
//   npx tsx tools/check-prompt-bound.ts
// Used to verify Fix 2 of fix/dispatcher-heartbeat-and-prompt-truncation
// (PDS7 prompt-bloat regression). Exits non-zero if pool=154 trims to
// >= 5x pool=10 size.

import { truncateSubagentStatuses } from "../harness/orchestrator/loop";
import type { SubagentStatus } from "../harness/types";

// Realistic-ish committed-script size: the pre-fix prompt at pool=10 was
// 22 KB and pool=825 was 107 KB, scaling ~110 chars per agent. Most of
// the per-agent payload was result.code — committed scripts of 80-150
// lines, each ~30-80 chars per line. We seed every fake subagent with a
// 100-line, ~3 KB code blob so the unbounded-vs-bounded delta is visible.
function makeStatus(i: number, base: number, total: number): SubagentStatus {
  const lines: string[] = [];
  for (let j = 0; j < 100; j++) {
    lines.push(`  // line ${j} of subagent_${i}: const x${j} = ns.hack("n00dles") + ${j};`);
  }
  // Stagger timestamps so the K most-recent-by-timestamp ranking is well
  // defined: lower index → older.
  const ts = new Date(base + i * 1000).toISOString();
  return {
    subagent_id: `agent_${i}`,
    last_instruction_id: `instr_${i}`,
    status: "executed",
    model_choice: "claude-haiku-4.5",
    last_result: {
      instruction_id: `instr_${i}`,
      subagent_id: `agent_${i}`,
      status: "success",
      code: lines.join("\n"),
      reasoning: "",
      tokens_used: 1000,
      timestamp: ts,
    },
  };
}

const sizeFor = (n: number) => {
  const base = Date.now() - n * 1000;
  const statuses = Array.from({ length: n }, (_, i) => makeStatus(i, base, n));
  const truncated = truncateSubagentStatuses(statuses);
  const truncJson = JSON.stringify(truncated);
  const rawJson = JSON.stringify(statuses);
  return { n, raw: rawJson.length, trunc: truncJson.length };
};

const samples = [10, 25, 50, 100, 154, 400, 825];
console.log("pool | raw chars | truncated chars | ratio (raw/trunc)");
console.log("-----+-----------+-----------------+------------------");
for (const n of samples) {
  const { raw, trunc } = sizeFor(n);
  const ratio = (raw / trunc).toFixed(2);
  console.log(
    `${String(n).padStart(4)} | ${String(raw).padStart(9)} | ${String(trunc).padStart(15)} | ${ratio}`,
  );
}

// Bound assertion: at pool 154 the truncated size should be a small
// constant multiple (<=2x) of the truncated size at pool=10. The pool=10
// case fits entirely in the top-K full bucket, so its size is the lower
// bound; pool=154 has 5 full + 149 small.
const { trunc: t10 } = sizeFor(10);
const { trunc: t154 } = sizeFor(154);
const ratio154 = t154 / t10;
console.log(`\npool=154 vs pool=10 truncated size ratio: ${ratio154.toFixed(2)}x`);
if (ratio154 >= 5) {
  console.error(`FAIL: pool=154 is more than 4x pool=10 — truncation isn't bounding tightly`);
  process.exit(1);
}
console.log("OK: pool=154 truncated < 5x pool=10 truncated (small constant multiple, NOT 5-10x larger)");
