# harness/subagent/

Subagent worker pool. Consumes `instructions` from the bus, invokes
the configured inference adapter, publishes `results`.

## Concurrency

Async tasks within the main Node process, with a semaphore limiting
concurrent in-flight calls to `subagent_limits.max_concurrent` (default
5). No worker threads, no child processes — inference latency is
already I/O bound against Ollama/HTTP endpoints.

## Per-instruction enforcement

- `max_tokens` = `token_budget` from the instruction (default 2000).
- Hard timeout = `timeout_seconds` (default 300). On timeout we
  cancel the adapter call if the adapter supports abort, otherwise we
  let it run but publish a `status: "timeout"` result immediately.
- On adapter error, publish a `status: "error"` result with the error
  message. No retry in-cycle; the orchestrator decides whether to
  reissue.

## Subagent state

Subagents have no memory across instructions (SPEC §"Core Constraints" #4).
Each instruction is a fresh inference call with only the `task` and
`context` the orchestrator chose to send.
