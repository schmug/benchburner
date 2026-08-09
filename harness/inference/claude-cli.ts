/**
 * Inference via the locally-authenticated `claude` CLI, so a run can use
 * Claude models without a separate API key.
 *
 * The CLI is used as a **completion endpoint**, not as an agent:
 * `--max-turns 1` with no tools. That distinction is the whole design.
 * A nested agent loop inside a subagent slot would be unbounded and
 * unattributable — the harness could no longer say what the subagent did
 * or bound how long it took — and CLAUDE.md constraints 1 and 3 depend on
 * the harness owning the write-run-observe loop.
 *
 * ## Leak isolation
 *
 * The CLI reads project context from disk. Invoked inside this
 * repository and asked what the project is, it answers "Bitburner" — it
 * has read CLAUDE.md. That is exactly the disclosure SPEC §3.3 forbids,
 * and `detectLeaks` cannot catch it because the leak never passes
 * through the prompt.
 *
 * Four things prevent it, and all four are load-bearing:
 *   - an empty working directory outside the repo (no CLAUDE.md in scope)
 *   - `--exclude-dynamic-system-prompt-sections` (no user-level context)
 *   - `--system-prompt` replacing the default Claude Code prompt
 *   - `--strict-mcp-config` with no servers (no MCP tools or their prose)
 *
 * ## Cost
 *
 * Measured on this machine: ~39K tokens and ~$0.21 per call in steady
 * state, almost all of it an irreducible preamble that no flag removes.
 * Whether that is billed or covered by a subscription depends on how the
 * CLI is authenticated — the harness records what the CLI reports.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  InferenceAdapter,
  InferenceInvokeParams,
  InferenceResult,
} from "../types";

/** Shape of `claude -p --output-format json`. */
interface CliEnvelope {
  is_error?: boolean;
  result?: string;
  stop_reason?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export interface ClaudeCliOptions {
  /** Path to the CLI. Defaults to `claude` on PATH. */
  binary?: string;
  /**
   * Max stdout bytes. A subagent turn returns a script plus notes; 32 MB
   * is far above that and well below anything that would strain memory.
   */
  maxBuffer?: number;
}

export class ClaudeCliAdapter implements InferenceAdapter {
  readonly name = "claude-cli";
  private readonly binary: string;
  private readonly maxBuffer: number;

  constructor(opts: ClaudeCliOptions = {}) {
    this.binary = opts.binary ?? "claude";
    this.maxBuffer = opts.maxBuffer ?? 32 * 1024 * 1024;
  }

  async invoke(params: InferenceInvokeParams): Promise<InferenceResult> {
    // A fresh empty directory per call. Per-call rather than per-adapter
    // because the registry shares one adapter across concurrent
    // subagents, and a shared cwd would let one call's stray file
    // become another call's context.
    const cwd = mkdtempSync(path.join(tmpdir(), "benchburner-cli-"));

    const args = [
      "-p",
      "--output-format",
      "json",
      // Completion endpoint, not an agent. See the module comment.
      "--max-turns",
      "1",
      "--model",
      params.model,
      "--exclude-dynamic-system-prompt-sections",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--disallowedTools",
      "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task,TodoWrite,NotebookEdit",
    ];
    // Replacing the system prompt is what removes the Claude Code
    // persona and its tool prose. Always send one, even if empty-ish.
    args.push("--system-prompt", params.system ?? "You are a helpful assistant.");

    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = execFile(
          this.binary,
          args,
          { cwd, maxBuffer: this.maxBuffer, signal: params.signal },
          (err, out, stderr) => {
            if (err) {
              reject(
                new Error(
                  `claude-cli: ${err.message}${stderr ? ` — ${String(stderr).slice(0, 500)}` : ""}`,
                ),
              );
              return;
            }
            resolve(out);
          },
        );
        // The prompt goes on stdin: an orchestrator prompt can run to
        // tens of KB and argv limits are a silent truncation hazard.
        child.stdin?.end(params.prompt);
      });

      let env: CliEnvelope;
      try {
        env = JSON.parse(stdout) as CliEnvelope;
      } catch {
        throw new Error(
          `claude-cli: expected JSON from --output-format json, got ${stdout.length} bytes starting ${JSON.stringify(stdout.slice(0, 200))}`,
        );
      }

      const u = env.usage ?? {};
      const tokens_used =
        (u.input_tokens ?? 0) +
        (u.output_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0);

      // An is_error envelope (rate limit, refusal, overload) is a real
      // outcome the orchestrator should see, not an exception — the
      // harness already treats finish_reason "error" as a failed turn.
      const finish_reason: InferenceResult["finish_reason"] = env.is_error
        ? "error"
        : env.stop_reason === "max_tokens"
          ? "length"
          : "stop";

      return { text: env.result ?? "", tokens_used, finish_reason };
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
}
