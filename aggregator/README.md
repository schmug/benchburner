# aggregator/

Reads per-run JSON artifacts under `results/<run_id>/` and emits the
static leaderboard site to `pages/`. SPEC §8 + §9.

The frontend design lives under `aggregator/templates/` (CSS + JSX +
copied verbatim into `pages/` on each build). The aggregator owns
data shaping; the JSX owns presentation.

## Outputs

`pages/` is fully generated and gitignored. Each build writes:

| Path | Notes |
|---|---|
| `index.html`, `about.html` | Page shells |
| `runs/<run_id>/index.html` | One per run; loads run via `window.BB_RUN_ID` |
| `runs/<run_id>/{summary,delegations,scripts,snapshots}.json` | Copied from `results/` |
| `data.js` | `window.BB_DATA = { meta, entries[] }` — feeds the JSX |
| `leaderboard.json` | Machine-readable, model-mean rankings |
| `styles.css`, `extra.css`, `*.jsx` | Copied from `aggregator/templates/` |

## Two ranking views

The design's `data.js` ranks **per run** (one row per `results/<id>/`).
`leaderboard.json` keeps the **per-model mean** aggregation so external
tools can compare orchestrators across runs:

```jsonc
{
  "generated_at": "2026-04-22T14:00:00Z",
  "bitburner_commit": "a4b0f22a...",
  "entries": [
    {
      "rank": 1,
      "orchestrator_model": "claude-haiku-4-6",
      "display_model": "claude-haiku-4-6",
      "attribution": "public",
      "run_count": 3,
      "final_money_mean": 4321000000000,
      "final_money_std": 120000000000,
      "completed_runs": 3,
      "failed_runs": 0,
      "latest_run_id": "...",
      "latest_artifact_url": "runs/<run_id>/",
      "branch": "orchestrator/claude-haiku-4-6",
      "bitburner_commit": "a4b0f22a..."
    }
  ],
  "raw_runs": [/* every RunSummary, sorted desc by final_money */]
}
```

## Milestone scope

Current build reads local `results/*` only. Multi-branch fan-out
(checkout each `orchestrator/*`, harvest its latest `summary.json`)
remains a post-M1 task and lands in the GitHub Action.

## Editing the design

The committed source of truth is `aggregator/templates/`. Don't edit
`pages/*` directly — it's overwritten on the next build. To change a
field's shape, update both:

1. `aggregator/build.ts` (the `DesignEntry` interface + `loadDesignEntry`)
2. The consuming JSX in `aggregator/templates/`
