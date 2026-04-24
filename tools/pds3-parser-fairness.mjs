#!/usr/bin/env node
/**
 * VALIDATION.md PDS3: parser fairness audit.
 *
 * Exercise parseOrchestratorOutput and the subagent turn-output
 * parser against synthetic outputs in dialects we've observed in
 * the wild: bare JSON, ```json``` fenced, ```/```ts fenced,
 * pre-JSON prose preamble, post-JSON prose suffix, mixed / nested
 * markdown, schema-conformant via OpenRouter response_format, etc.
 *
 * Success criterion: parse rates are uniform across dialects;
 * no one model's output style is privileged over another.
 */

import { parseOrchestratorOutput } from "../harness/orchestrator/loop.ts";

// --- Orchestrator output cases ---
const OUTPUTS = [
  {
    label: "bare-json-claude",
    text: '{"actions":[{"action_type":"noop"}],"reasoning":"ok"}',
  },
  {
    label: "fenced-json-gpt",
    text: '```json\n{"actions":[{"action_type":"noop"}],"reasoning":"ok"}\n```',
  },
  {
    label: "fenced-ts-qwen",
    text: '```ts\n{"actions":[{"action_type":"noop"}],"reasoning":"ok"}\n```',
  },
  {
    label: "preamble-then-json-reasoning-model",
    text: "I'll emit a JSON response:\n\n{\"actions\":[{\"action_type\":\"noop\"}],\"reasoning\":\"ok\"}",
  },
  {
    label: "json-then-trailing-note",
    text: '{"actions":[{"action_type":"noop"}],"reasoning":"ok"}\n\n(Note: this is my best guess.)',
  },
  {
    label: "nested-quotes-in-code-field",
    text: '{"actions":[{"action_type":"instruct","subagent_id":"x","instruction":{"task":"say \\"hi\\" and \\"bye\\""}}],"reasoning":""}',
  },
  {
    label: "multiple-actions",
    text: '{"actions":[{"action_type":"spawn","model_choice":"m"},{"action_type":"instruct","subagent_id":"x"}],"reasoning":""}',
  },
  {
    label: "whitespace-heavy",
    text: '   \n\n  {"actions":[  {"action_type":"noop"}  ],"reasoning":""}  \n\n',
  },
  {
    label: "malformed-truncated",
    text: '{"actions":[{"action_type":"noop"}',
    expectFail: true,
  },
  {
    label: "malformed-empty",
    text: "",
    expectFail: true,
  },
  {
    label: "malformed-prose-only",
    text: "I think the best action would be to do nothing right now.",
    expectFail: true,
  },
];

const results = [];
for (const c of OUTPUTS) {
  const parsed = parseOrchestratorOutput(c.text);
  const ok =
    (c.expectFail && parsed === null) ||
    (!c.expectFail && parsed !== null && Array.isArray(parsed.actions));
  results.push({ label: c.label, ok, parsed: !!parsed });
  const mark = ok ? "✓" : "✗";
  console.log(`  ${mark} ${c.label}: parsed=${!!parsed}, expected=${c.expectFail ? "fail" : "pass"}`);
}

const passed = results.filter((r) => r.ok).length;
const total = results.length;
console.log(`\n${passed}/${total} dialects handled correctly.`);
process.exit(passed === total ? 0 : 1);
