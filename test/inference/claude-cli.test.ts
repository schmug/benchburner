/**
 * The `claude` CLI on this machine is already authenticated, so it can
 * act as an inference endpoint without a separate API key. Wrapping it
 * as an InferenceAdapter keeps the harness in control of the
 * write-run-observe loop — the CLI is used as a completion endpoint
 * (`--max-turns 1`, no tools), never as a nested agent, which would put
 * an unbounded, unattributable tool loop inside a subagent slot.
 *
 * The load-bearing property is isolation, not plumbing. Run in the repo
 * and the CLI reads CLAUDE.md; asked what the project is, it answers
 * "Bitburner" — leaking the game identity that SPEC §3.3 forbids and
 * that `detectLeaks` cannot see, because the leak arrives through the
 * filesystem rather than the prompt. These tests pin the flags and the
 * working directory that prevent it.
 *
 * A stub binary stands in for the real CLI so the suite costs nothing.
 */

import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, describe } from "node:test";

import { ClaudeCliAdapter } from "../../harness/inference/claude-cli";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "benchburner-cli-"));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));

let seq = 0;

/**
 * Writes a fake `claude` that records how it was invoked (argv, cwd,
 * stdin) to a JSON file and emits a canned CLI response.
 */
function stub(opts: { body?: string; exitCode?: number; hangMs?: number } = {}) {
  const dir = mkdtempSync(path.join(tmpRoot, `stub-${seq++}-`));
  const capture = path.join(dir, "capture.json");
  const bin = path.join(dir, "claude-stub.mjs");
  const body =
    opts.body ??
    JSON.stringify({
      is_error: false,
      stop_reason: "end_turn",
      result: "PONG",
      usage: {
        input_tokens: 2,
        output_tokens: 4,
        cache_creation_input_tokens: 20463,
        cache_read_input_tokens: 18577,
      },
      total_cost_usd: 0.2141,
    });

  writeFileSync(
    bin,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
let stdin = "";
try { stdin = readFileSync(0, "utf8"); } catch {}
writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
  argv: process.argv.slice(2), cwd: process.cwd(), stdin,
}));
${opts.hangMs ? `await new Promise(r => setTimeout(r, ${opts.hangMs}));` : ""}
process.stdout.write(${JSON.stringify(body)});
process.exit(${opts.exitCode ?? 0});
`,
    "utf8",
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    read: () => JSON.parse(readFileSync(capture, "utf8")) as {
      argv: string[];
      cwd: string;
      stdin: string;
    },
  };
}

const adapter = (bin: string) => new ClaudeCliAdapter({ binary: bin });

describe("ClaudeCliAdapter — response mapping", () => {
  test("maps the CLI's JSON envelope onto InferenceResult", async () => {
    const s = stub();
    const r = await adapter(s.bin).invoke({
      model: "claude-opus-5",
      prompt: "say pong",
      max_tokens: 2000,
    });

    assert.equal(r.text, "PONG");
    assert.equal(r.finish_reason, "stop");
    // All four usage buckets count: the preamble arrives as cache
    // creation/read and is the dominant cost of a CLI call.
    assert.equal(r.tokens_used, 2 + 4 + 20463 + 18577);
  });

  test("reports a CLI-level error as finish_reason error rather than throwing", async () => {
    const s = stub({
      body: JSON.stringify({ is_error: true, result: "rate limited" }),
    });
    const r = await adapter(s.bin).invoke({
      model: "claude-opus-5",
      prompt: "x",
      max_tokens: 100,
    });
    assert.equal(r.finish_reason, "error");
    assert.match(r.text, /rate limited/);
  });

  test("throws a diagnosable error when the CLI emits non-JSON", async () => {
    const s = stub({ body: "not json at all" });
    await assert.rejects(
      () => adapter(s.bin).invoke({ model: "m", prompt: "x", max_tokens: 10 }),
      /claude-cli/i,
    );
  });

  test("throws when the CLI exits non-zero", async () => {
    const s = stub({ body: "", exitCode: 3 });
    await assert.rejects(() =>
      adapter(s.bin).invoke({ model: "m", prompt: "x", max_tokens: 10 }),
    );
  });
});

describe("ClaudeCliAdapter — leak isolation", () => {
  test("runs outside the repository, so no CLAUDE.md is in scope", async () => {
    const s = stub();
    await adapter(s.bin).invoke({ model: "m", prompt: "x", max_tokens: 10 });

    const { cwd } = s.read();
    const repoRoot = path.resolve(import.meta.dirname, "..", "..");
    assert.equal(
      cwd.startsWith(repoRoot),
      false,
      `CLI ran inside the repo (${cwd}) — it would read CLAUDE.md and learn the game`,
    );
  });

  test("passes the flags that keep project context out of the session", async () => {
    const s = stub();
    await adapter(s.bin).invoke({
      model: "claude-opus-5",
      prompt: "x",
      system: "You write code.",
      max_tokens: 10,
    });

    const { argv } = s.read();
    // Each of these closes a distinct path by which repo or user context
    // reaches the subagent.
    assert.ok(argv.includes("--exclude-dynamic-system-prompt-sections"));
    assert.ok(argv.includes("--strict-mcp-config"));
    assert.ok(argv.includes("--max-turns"), "must not run as a nested agent");
    assert.equal(argv[argv.indexOf("--max-turns") + 1], "1");
    assert.ok(argv.includes("--system-prompt"), "default system prompt must be replaced");
    assert.equal(argv[argv.indexOf("--system-prompt") + 1], "You write code.");
    assert.equal(argv[argv.indexOf("--model") + 1], "claude-opus-5");
  });

  test("sends the prompt on stdin, not argv, so long prompts cannot be truncated", async () => {
    const s = stub();
    const big = "N".repeat(200_000);
    await adapter(s.bin).invoke({ model: "m", prompt: big, max_tokens: 10 });

    const { argv, stdin } = s.read();
    assert.equal(stdin, big);
    assert.equal(
      argv.some((a) => a.includes("NNNN")),
      false,
      "prompt must not appear in argv",
    );
  });
});

describe("ClaudeCliAdapter — cancellation", () => {
  test("honors an AbortSignal so a cycle deadline can cut a slow call", async () => {
    const s = stub({ hangMs: 10_000 });
    const controller = new AbortController();
    const pending = adapter(s.bin).invoke({
      model: "m",
      prompt: "x",
      max_tokens: 10,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(() => pending);
  });
});
