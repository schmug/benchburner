#!/usr/bin/env node
/**
 * Quick OpenRouter probe:
 *   1) list models matching a prefix so we can confirm exact slugs
 *   2) send one tiny request to confirm auth + flow
 *
 * Run:  OPENROUTER_API_KEY=sk-or-v1-... node tools/probe-openrouter.mjs
 */
const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY) {
  console.error("Set OPENROUTER_API_KEY in the environment.");
  process.exit(1);
}

const BASE = "https://openrouter.ai/api/v1";
const HEADERS = {
  authorization: `Bearer ${KEY}`,
  "content-type": "application/json",
  "http-referer": "https://github.com/thebreakawayguy/benchburner",
  "x-title": "Benchburner (probe)",
};

async function listModels(prefix) {
  const res = await fetch(`${BASE}/models`, { headers: HEADERS });
  if (!res.ok) {
    console.error(`models fetch failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const data = await res.json();
  return data.data
    .filter((m) => m.id.startsWith(prefix))
    .map((m) => ({ id: m.id, ctx: m.context_length, cost: m.pricing }));
}

async function chat(model) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      model,
      max_tokens: 40,
      messages: [
        { role: "system", content: "Reply with the single word PING." },
        { role: "user", content: "go" },
      ],
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`chat ${model}: ${res.status} ${text.slice(0, 300)}`);
    return null;
  }
  const data = JSON.parse(text);
  return data.choices?.[0]?.message?.content ?? "(empty)";
}

const anthropic = await listModels("anthropic/");
const openai = await listModels("openai/gpt-");
console.log("--- anthropic models available ---");
anthropic.forEach((m) => console.log(`  ${m.id}  ctx=${m.ctx}`));
console.log("--- openai gpt-* models available ---");
openai.slice(0, 10).forEach((m) => console.log(`  ${m.id}  ctx=${m.ctx}`));

// Probe the newest-looking Claude.
const probeClaude = anthropic.find((m) => /opus/i.test(m.id)) ?? anthropic[0];
if (probeClaude) {
  console.log(`\n--- probing ${probeClaude.id} ---`);
  const r = await chat(probeClaude.id);
  console.log("  response:", JSON.stringify(r));
}
