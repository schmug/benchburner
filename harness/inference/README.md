# harness/inference/

Model invocation abstraction. Any orchestrator or subagent call goes
through `InferenceAdapter`. Adding a new model is config-only, not
code.

## Interface (SPEC §6)

```ts
interface InferenceAdapter {
  name: string;
  invoke(params: {
    model: string;
    prompt: string;
    max_tokens: number;
    system?: string;
    stop?: string[];
  }): Promise<{
    text: string;
    tokens_used: number;
    finish_reason: "stop" | "length" | "error";
  }>;
}
```

## Adapters shipped

| adapter | transport | use                                            |
|---------|-----------|------------------------------------------------|
| `ollama`| HTTP      | Local Ollama daemon (`http://localhost:11434`) |
| `http`  | HTTP      | Generic OpenAI-compatible (`/v1/chat/completions`) — covers vLLM, Together, HF TGI, the OpenAI API proper |
| `claude-cli` | subprocess | The locally-authenticated `claude` binary, so Claude models need no API key. `endpoint` is repurposed as the binary path (`claude` = PATH). |

Registry loads `config/models.yaml` and returns `(adapter, modelConfig)`
tuples keyed by model id.

### `claude-cli` — two things to know before using it

**It is a completion endpoint, not an agent.** Invoked with
`--max-turns 1` and no tools. Letting the CLI run its own tool loop
inside a subagent slot would put an unbounded, unattributable agent
where the harness expects one turn — the harness could no longer bound
how long a subagent takes or say what it did, and CLAUDE.md constraints
1 and 3 both assume the harness owns the write-run-observe loop.

**It leaks the game unless isolated.** The CLI reads project context off
disk. Run inside this repository and asked what the project is, it
answers "Bitburner" — it has read `CLAUDE.md`. That is the disclosure
SPEC §3.3 forbids, and `detectLeaks` cannot catch it because the leak
never passes through the prompt. Four measures prevent it and all four
are load-bearing: an empty working directory outside the repo, a
replaced `--system-prompt`, `--exclude-dynamic-system-prompt-sections`,
and `--strict-mcp-config` with no servers. There is a test asserting
each.

Cost: ~39K tokens and ~$0.21 per call in steady state as measured on a
dev machine, nearly all of it a preamble no flag removes — roughly 3×
the per-token cost of the same model over `http`. It buys you "no API
key", not "cheaper". Whether the reported cost is billed or covered by a
subscription depends on how the CLI is authenticated.

## Defaults applied (from HANDOFF)

- Subagent token budget: 2000 (enforced by worker, not the adapter).
- Request timeout per subagent call: 300s.
- No retries; an inference failure surfaces as a `Result` with
  `status: "error"`.
