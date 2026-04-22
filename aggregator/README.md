# aggregator/

Reads per-run `summary.json` files across orchestrator branches and
builds the static leaderboard (`pages/leaderboard.json` +
`pages/index.html`).

## Milestone 1 scope

Minimal. Reads local `results/*/summary.json` only (no multi-branch
fan-out). Sorts by `final_money`. Emits a flat JSON leaderboard and a
trivial HTML index page to `pages/`.

Multi-branch aggregation (SPEC §8) is a post-M1 task that will
delegate the actual frontend design to Claude Design. Our job here is
to guarantee the input JSON shapes are stable.

## Output contract

`pages/leaderboard.json`:

```json
{
  "generated_at": "2026-04-22T14:00:00Z",
  "bitburner_commit": "a4b0f22a2...",
  "entries": [
    {
      "rank": 1,
      "orchestrator_model": "llama3:8b",
      "attribution": "public",
      "final_money": 12345,
      "bitnodes_completed": 0,
      "augments_installed": 0,
      "status": "completed",
      "run_id": "uuid",
      "branch": "orchestrator/smoke-test",
      "artifact_url": "runs/<run_id>/"
    }
  ]
}
```
