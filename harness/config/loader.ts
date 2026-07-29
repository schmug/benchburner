/**
 * Run config loader. Reads YAML from disk, applies HANDOFF.md default
 * values, replaces run_id="auto" with a fresh UUID, and returns a
 * fully-populated RunConfig. See SPEC.md §10.1 for the schema and
 * CLAUDE.md § "Decisions Claude Code Should Make" for the defaults.
 *
 * Validation is intentionally strict on the required fields (so typos
 * in prod configs fail fast) and lenient on the optional/default
 * fields (so the example config stays minimal).
 */

import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { v4 as uuidv4 } from "uuid";
import type { RunConfig } from "../types.ts";

// Defaults from CLAUDE.md and HANDOFF.md.
const DEFAULTS = {
  orchestrator: {
    polling_interval_seconds: 60,
    history_window: 10,
    hang_timeout_seconds: 600,
  },
  subagent_limits: {
    max_concurrent: 5,
    token_budget_per_instruction: 2000,
    timeout_seconds: 300,
  },
  attribution_mode: "public" as const,
};

function fail(msg: string): never {
  throw new Error(`Invalid run config: ${msg}`);
}

function asRecord(v: unknown, path: string): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    fail(`${path} must be an object`);
  }
  return v as Record<string, unknown>;
}

function asString(v: unknown, path: string): string {
  if (typeof v !== "string" || v.length === 0) {
    fail(`${path} must be a non-empty string`);
  }
  return v;
}

function asNumber(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    fail(`${path} must be a finite number`);
  }
  return v;
}

function asInteger(v: unknown, path: string): number {
  const n = asNumber(v, path);
  if (!Number.isInteger(n)) fail(`${path} must be an integer`);
  return n;
}

function asStringArray(v: unknown, path: string): string[] {
  if (!Array.isArray(v)) fail(`${path} must be an array`);
  return v.map((el, i) => asString(el, `${path}[${i}]`));
}

/**
 * Validate `orchestrator.per_cycle_timeout_seconds`. Must be a positive
 * integer ≤ 3600 (one hour). The cap is a guard against a misconfig
 * pinning the per-cycle deadline so high that the hang detector loses
 * its purpose entirely; if you want longer than 3600s per cycle, you
 * almost certainly want a different orchestrator model.
 */
function asPerCycleTimeout(v: unknown): number {
  const n = asInteger(v, "orchestrator.per_cycle_timeout_seconds");
  if (n <= 0) {
    fail(`orchestrator.per_cycle_timeout_seconds must be positive (got ${n})`);
  }
  if (n > 3600) {
    fail(
      `orchestrator.per_cycle_timeout_seconds must be ≤ 3600 (got ${n})`,
    );
  }
  return n;
}

/**
 * Resolves the run duration to seconds from exactly one of
 * `duration_hours` or `duration_minutes`. See the call site for why
 * "exactly one" rather than a precedence rule.
 */
function resolveDuration(root: Record<string, unknown>): number {
  const hasHours = root.duration_hours !== undefined;
  const hasMinutes = root.duration_minutes !== undefined;

  if (hasHours === hasMinutes) {
    fail(
      `exactly one of duration_hours or duration_minutes is required (got ${
        hasHours ? "both" : "neither"
      })`,
    );
  }

  const [key, perUnit] = hasHours
    ? (["duration_hours", 3600] as const)
    : (["duration_minutes", 60] as const);
  const value = asNumber(root[key], key);
  if (value <= 0) fail(`${key} must be > 0`);
  return value * perUnit;
}

/**
 * Loads and validates a run config from YAML. Replaces run_id="auto"
 * with a freshly generated UUID. Applies all HANDOFF.md default values
 * for any fields the user omitted. Returns a fully-populated RunConfig.
 * Throws a clear error on schema violations (missing required fields,
 * type mismatches, etc.).
 */
export function loadRunConfig(yamlPath: string): RunConfig {
  const raw = readFileSync(yamlPath, "utf8");
  const parsed = yaml.load(raw);
  const root = asRecord(parsed, "run config");

  // run_id: "auto" | string
  let runId: string;
  if (root.run_id === undefined || root.run_id === "auto") {
    runId = uuidv4();
  } else {
    runId = asString(root.run_id, "run_id");
  }

  // orchestrator (required sub-keys: model)
  const orchestratorRaw = asRecord(root.orchestrator, "orchestrator");
  const orchestrator = {
    model: asString(orchestratorRaw.model, "orchestrator.model"),
    polling_interval_seconds:
      orchestratorRaw.polling_interval_seconds === undefined
        ? DEFAULTS.orchestrator.polling_interval_seconds
        : asNumber(
            orchestratorRaw.polling_interval_seconds,
            "orchestrator.polling_interval_seconds",
          ),
    history_window:
      orchestratorRaw.history_window === undefined
        ? DEFAULTS.orchestrator.history_window
        : asInteger(orchestratorRaw.history_window, "orchestrator.history_window"),
    hang_timeout_seconds:
      orchestratorRaw.hang_timeout_seconds === undefined
        ? DEFAULTS.orchestrator.hang_timeout_seconds
        : asNumber(
            orchestratorRaw.hang_timeout_seconds,
            "orchestrator.hang_timeout_seconds",
          ),
    ...(orchestratorRaw.per_cycle_timeout_seconds === undefined
      ? {}
      : {
          per_cycle_timeout_seconds: asPerCycleTimeout(
            orchestratorRaw.per_cycle_timeout_seconds,
          ),
        }),
  };

  // subagent_roster
  const subagentRoster = asStringArray(root.subagent_roster, "subagent_roster");
  if (subagentRoster.length === 0) fail("subagent_roster must be non-empty");

  // subagent_limits (optional, all-defaulted)
  const limitsRaw =
    root.subagent_limits === undefined
      ? {}
      : asRecord(root.subagent_limits, "subagent_limits");
  const subagentLimits = {
    max_concurrent:
      limitsRaw.max_concurrent === undefined
        ? DEFAULTS.subagent_limits.max_concurrent
        : asInteger(limitsRaw.max_concurrent, "subagent_limits.max_concurrent"),
    token_budget_per_instruction:
      limitsRaw.token_budget_per_instruction === undefined
        ? DEFAULTS.subagent_limits.token_budget_per_instruction
        : asInteger(
            limitsRaw.token_budget_per_instruction,
            "subagent_limits.token_budget_per_instruction",
          ),
    timeout_seconds:
      limitsRaw.timeout_seconds === undefined
        ? DEFAULTS.subagent_limits.timeout_seconds
        : asNumber(limitsRaw.timeout_seconds, "subagent_limits.timeout_seconds"),
  };

  // game (both sub-keys required)
  const gameRaw = asRecord(root.game, "game");
  const seed = asInteger(gameRaw.seed, "game.seed");
  // Seeds must be non-negative: the orchestrator's leak detector
  // matches String(seed) against the rendered prompt, and negative
  // integers stringify with a leading "-" (a non-word character).
  // Word-boundary regex matching can miss "value=-1234" because both
  // sides are non-word, leaking the seed. Enforce the contract here
  // so detectLeaks can stay simple.
  if (seed < 0) {
    fail(`game.seed must be a non-negative integer (got ${seed}); negative seeds bypass orchestrator leak detection`);
  }
  const game = {
    bitburner_commit: asString(gameRaw.bitburner_commit, "game.bitburner_commit"),
    seed,
  };

  // duration — exactly one of duration_hours / duration_minutes.
  //
  // duration_minutes exists because the canonical measurement run is
  // 20 minutes, which whole hours cannot express. Before it existed,
  // every canonical run in VALIDATION.md was produced by the dev-only
  // BENCHBURNER_DURATION_SEC override while its config file claimed
  // `duration_hours: 1` — so the configs did not describe the runs.
  //
  // Requiring exactly one is what keeps that from recurring: a config
  // carrying both keys is precisely the ambiguity that let the two
  // drift apart, so it is an error rather than a precedence rule.
  const durationSeconds = resolveDuration(root);

  // snapshot_interval_seconds (optional; timer defaults it proportionally)
  let snapshotIntervalSeconds: number | undefined;
  if (root.snapshot_interval_seconds !== undefined) {
    const n = asNumber(root.snapshot_interval_seconds, "snapshot_interval_seconds");
    if (n <= 0) fail("snapshot_interval_seconds must be > 0");
    if (n > durationSeconds) {
      fail(
        `snapshot_interval_seconds (${n}) must not exceed the run duration (${durationSeconds}s); ` +
          `that yields a single snapshot and strips the orchestrator's snapshot channel`,
      );
    }
    snapshotIntervalSeconds = n;
  }

  // attribution_mode
  let attributionMode: "public" | "anonymous";
  if (root.attribution_mode === undefined) {
    attributionMode = DEFAULTS.attribution_mode;
  } else {
    const s = asString(root.attribution_mode, "attribution_mode");
    if (s !== "public" && s !== "anonymous") {
      fail(`attribution_mode must be "public" or "anonymous" (got "${s}")`);
    }
    attributionMode = s;
  }

  return {
    run_id: runId,
    orchestrator,
    subagent_roster: subagentRoster,
    subagent_limits: subagentLimits,
    game,
    duration_seconds: durationSeconds,
    snapshot_interval_seconds: snapshotIntervalSeconds,
    attribution_mode: attributionMode,
  };
}

/** Parse just the model roster fields for orchestration-time validation. */
export function extractModelIdsReferenced(config: RunConfig): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of [config.orchestrator.model, ...config.subagent_roster]) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
