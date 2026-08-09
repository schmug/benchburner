/**
 * Loads `config/models.yaml` and hands out adapter instances keyed by
 * model id. Adding a model is config-only (SPEC §6) — this file is the
 * only place the harness bridges config rows into live adapters.
 *
 * Adapter instances are cached by `(adapter, endpoint, apiKey)` so
 * multiple model ids sharing the same endpoint (e.g. two Ollama models
 * on the same daemon) reuse a single instance.
 */

import * as fs from "node:fs";
import * as yaml from "js-yaml";
import type { InferenceAdapter, ModelConfig } from "../types";
import { OllamaAdapter } from "./ollama";
import { HTTPAdapter } from "./http";
import { TestHangAdapter } from "./test-hang";
import { TestScriptedAdapter } from "./test-scripted";
import { ClaudeCliAdapter } from "./claude-cli";
import { NullOrchestratorAdapter } from "./null-orchestrator";

/**
 * Parse a `models.yaml` file into a validated `ModelConfig[]`. Throws
 * on missing required fields so misconfig fails fast at harness start.
 */
export function loadModelsYaml(path: string): ModelConfig[] {
  const raw = fs.readFileSync(path, "utf8");
  const parsed = yaml.load(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(
      `models.yaml at ${path} must be a YAML list of model entries`,
    );
  }

  const out: ModelConfig[] = [];
  for (const [i, entry] of parsed.entries()) {
    if (!entry || typeof entry !== "object") {
      throw new Error(`models.yaml entry #${i} is not an object`);
    }
    const e = entry as Record<string, unknown>;

    const id = e.id;
    const adapter = e.adapter;
    const endpoint = e.endpoint;
    const context_window = e.context_window;

    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`models.yaml entry #${i} missing string "id"`);
    }
    if (
      adapter !== "ollama" &&
      adapter !== "http" &&
      adapter !== "test-hang" &&
      adapter !== "test-scripted" &&
      adapter !== "null-orchestrator" &&
      adapter !== "claude-cli"
    ) {
      throw new Error(
        `models.yaml entry "${id}" has invalid adapter "${String(adapter)}" (expected "ollama", "http", "claude-cli", "test-hang", "test-scripted", or "null-orchestrator")`,
      );
    }
    if (typeof endpoint !== "string" || endpoint.length === 0) {
      throw new Error(`models.yaml entry "${id}" missing string "endpoint"`);
    }
    if (typeof context_window !== "number" || !Number.isFinite(context_window)) {
      throw new Error(
        `models.yaml entry "${id}" missing numeric "context_window"`,
      );
    }

    const cfg: ModelConfig = {
      id,
      adapter,
      endpoint,
      context_window,
    };
    if (typeof e.model_name === "string") cfg.model_name = e.model_name;
    if (typeof e.api_key_env === "string") cfg.api_key_env = e.api_key_env;
    if (typeof e.supports_structured_output === "boolean") {
      cfg.supports_structured_output = e.supports_structured_output;
    }
    if (e.max_completion_tokens !== undefined) {
      const m = e.max_completion_tokens;
      if (typeof m !== "number" || !Number.isFinite(m) || m <= 0 || !Number.isInteger(m)) {
        throw new Error(
          `models.yaml entry "${id}" has invalid max_completion_tokens "${String(m)}" (expected positive integer)`,
        );
      }
      cfg.max_completion_tokens = m;
    }

    out.push(cfg);
  }
  return out;
}

export interface ResolvedAdapter {
  adapter: InferenceAdapter;
  config: ModelConfig;
  /** The string to pass as `model` into `adapter.invoke()`. */
  modelName: string;
}

export class InferenceRegistry {
  private readonly byId = new Map<string, ModelConfig>();
  private readonly cache = new Map<string, InferenceAdapter>();

  constructor(configs: ModelConfig[]) {
    for (const c of configs) {
      if (this.byId.has(c.id)) {
        throw new Error(`InferenceRegistry: duplicate model id "${c.id}"`);
      }
      this.byId.set(c.id, c);
    }
  }

  list(): string[] {
    return Array.from(this.byId.keys());
  }

  get(modelId: string): ResolvedAdapter {
    const config = this.byId.get(modelId);
    if (!config) {
      throw new Error(
        `InferenceRegistry: unknown model id "${modelId}" (known: ${this.list().join(", ")})`,
      );
    }

    // Resolve api_key lazily so unused models don't block startup.
    let apiKey: string | undefined;
    if (config.adapter === "http" && config.api_key_env) {
      apiKey = process.env[config.api_key_env];
      if (!apiKey) {
        throw new Error(
          `InferenceRegistry: model "${modelId}" requires env var ` +
            `${config.api_key_env}, which is not set`,
        );
      }
    }

    const cacheKey = `${config.adapter}|${config.endpoint}|${apiKey ?? ""}`;
    let adapter = this.cache.get(cacheKey);
    if (!adapter) {
      if (config.adapter === "ollama") {
        adapter = new OllamaAdapter({ endpoint: config.endpoint });
      } else if (config.adapter === "test-hang") {
        adapter = new TestHangAdapter();
      } else if (config.adapter === "test-scripted") {
        adapter = new TestScriptedAdapter();
      } else if (config.adapter === "null-orchestrator") {
        adapter = new NullOrchestratorAdapter();
      } else if (config.adapter === "claude-cli") {
        // `endpoint` is repurposed as the CLI path; "claude" means PATH.
        adapter = new ClaudeCliAdapter({
          binary: config.endpoint === "claude" ? undefined : config.endpoint,
        });
      } else {
        adapter = new HTTPAdapter({ endpoint: config.endpoint, apiKey });
      }
      this.cache.set(cacheKey, adapter);
    }

    return {
      adapter,
      config,
      modelName: config.model_name ?? config.id,
    };
  }
}
