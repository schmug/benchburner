#!/usr/bin/env node
/**
 * Read OpenRouter credit balance + cumulative usage for the active key.
 * Source .env first:  set -a && . ./.env && set +a && node tools/openrouter-usage.mjs
 *
 * Endpoints used:
 *   GET /api/v1/credits  -> { data: { total_credits, total_usage } }
 *   GET /api/v1/key      -> { data: { label, usage, limit, limit_remaining, ... } }
 *
 * Both work with any valid key; no extra scope needed.
 */
const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY) {
  console.error("Set OPENROUTER_API_KEY (source .env first).");
  process.exit(1);
}

const BASE = "https://openrouter.ai/api/v1";
const HEADERS = { authorization: `Bearer ${KEY}` };

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: HEADERS });
  if (!res.ok) {
    console.error(`${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return null;
  }
  return (await res.json()).data;
}

const [credits, key] = await Promise.all([get("/credits"), get("/key")]);

if (credits) {
  const used = Number(credits.total_usage ?? 0);
  const total = Number(credits.total_credits ?? 0);
  console.log(`credits:  used $${used.toFixed(4)} / purchased $${total.toFixed(2)}  (remaining $${(total - used).toFixed(4)})`);
}
if (key) {
  const usage = Number(key.usage ?? 0);
  const limit = key.limit == null ? null : Number(key.limit);
  const remaining = key.limit_remaining == null ? null : Number(key.limit_remaining);
  const limitStr = limit == null ? "no key-level cap" : `$${limit.toFixed(2)}`;
  const remainingStr = remaining == null ? "(unlimited)" : `$${remaining.toFixed(4)}`;
  console.log(`key:      label=${JSON.stringify(key.label ?? "")}  usage=$${usage.toFixed(4)}  limit=${limitStr}  remaining=${remainingStr}`);
}
