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

Registry loads `config/models.yaml` and returns `(adapter, modelConfig)`
tuples keyed by model id.

## Defaults applied (from HANDOFF)

- Subagent token budget: 2000 (enforced by worker, not the adapter).
- Request timeout per subagent call: 300s.
- No retries; an inference failure surfaces as a `Result` with
  `status: "error"`.
