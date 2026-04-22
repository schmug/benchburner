# CLAUDE.md — Project Intent & Working Agreement

This file is the source of truth for **why** this project exists. Read it before making architectural decisions. When in doubt, optimize for the intent described here, not for cleverness or completeness.

## What We Are Building

A public benchmark that measures the **orchestration capability** of large language models. Each benchmarked model acts as an *orchestrator* directing a team of *subagent* LLMs to play [Bitburner](https://github.com/bitburner-official/bitburner-src) for 24 hours of real wall-clock time. Orchestrators are scored on the total in-game money their team accumulates.

## What We Are Not Building

- **Not** a coding benchmark for single LLMs. Individual code quality is incidental.
- **Not** a game-playing AI. The game is the eval harness, not the subject.
- **Not** a live service. There is no live API, no persistent backend exposed to the internet.
- **Not** a general agent framework. This is narrowly scoped to the benchmark.

## Why This Matters

Software engineering with AI is moving toward orchestration: a manager model directing worker models. No public benchmark currently measures that skill cleanly. Bitburner works as the eval domain because (a) it has a real programming surface (Netscript), (b) scalar outcomes are unambiguous (money), and (c) strategies are diverse enough that orchestration decisions actually matter.

## Core Constraints (Non-Negotiable)

These shape every design decision. If a choice conflicts with these, the choice is wrong.

1. **The orchestrator cannot play the game directly.** It only spawns, kills, and instructs subagents.
2. **The orchestrator cannot edit subagent output.** It accepts or rejects whole results.
3. **The orchestrator sees only what subagents report + hourly game state snapshots.** No direct Bitburner access, no wiki, no strategy guides.
4. **Subagents have no long-term memory across runs.** Each 24h cycle starts fresh.
5. **Batch architecture.** Runs happen offline, results commit to Git, a static leaderboard builds once daily. No live API.
6. **Deterministic game state.** Bitburner is pinned to a specific fork commit and a pinned RNG seed — but the seed is **opaque to the orchestrator** (exposing it lets models overfit to one scenario instead of developing general orchestration strategy).
7. **Subagent roster is curated per run.** All orchestrators in a given cycle choose from the same pool. Fairness matters.

## Design Philosophy

- **Measure orchestration, not gameplay.** If a design choice makes the orchestrator more "powerful" at the expense of isolating management skill, reject it.
- **Reproducibility over features.** A simple, replayable run beats a fancy one.
- **Batch over live.** Static artifacts in Git. No exposed infrastructure.
- **White-label from day one.** Any model, with a conforming inference interface, should be pluggable as an orchestrator or subagent via config. No hard-coded model lists.
- **Intent over ops.** The point is a clean research artifact, not a SaaS product.

## Repository Structure (Target)

```
/                          # root
├── CLAUDE.md              # this file
├── README.md              # public overview
├── SPEC.md                # full technical spec
├── harness/               # orchestration harness (backend)
│   ├── orchestrator/      # orchestrator loop
│   ├── subagent/          # subagent invocation
│   ├── bus/               # in-memory message queue
│   ├── game/              # Bitburner instance management
│   ├── inference/         # model invocation abstraction
│   └── storage/           # SQLite persistence
├── bitburner/             # forked Bitburner, pinned commit (submodule or vendored)
├── config/                # per-run configs (models, rosters, seeds)
├── results/               # per-run artifacts (delegation logs, scripts, snapshots)
├── aggregator/            # builds static leaderboard from results/
├── pages/                 # static site output for Cloudflare Pages
└── .github/workflows/     # batch job + aggregator triggers
```

Branches: `main` holds the harness and shared infrastructure. Each orchestrator model gets its own branch (e.g. `orchestrator/llama-3-70b`) containing its run artifacts.

## Multi-Branch Run Model

- **`main`**: harness code, shared configs, aggregator, pages.
- **`orchestrator/<model-id>`**: one branch per orchestrator model being benchmarked. Contains that model's run artifacts under `results/`.
- **`results-published`**: auto-generated branch containing the aggregated static leaderboard. Deployed to Cloudflare Pages.

A daily aggregator job pulls the latest run from every `orchestrator/*` branch, parses artifacts, rebuilds the leaderboard, and pushes to `results-published`.

## Default Tech Stack

Claude Code should default to these unless there's a strong reason to deviate. When deviating, document why in the relevant module's README.

| Layer | Default | Rationale |
|---|---|---|
| Runtime | Node.js (LTS) | Bitburner is a Node.js game; avoids FFI. |
| Message bus | In-memory queue | Single-process batch job; no Redis needed. |
| State store | SQLite | Self-contained, file-based, commits cleanly with artifacts. |
| Inference | Pluggable via adapter pattern; default Ollama local | Works offline, controllable; adapters for vLLM / HTTP APIs. |
| Game instance | Headless Node fork of Bitburner | Pinned commit; no time acceleration (real-time 24h). |
| CI | GitHub Actions with self-hosted runners | Matches Cory's existing infra; avoids cloud inference costs. |
| Hosting | Cloudflare Pages | Static only; minimal attack surface. |

## Decisions Claude Code Should Make (Sensible Defaults OK)

These are calibration details. Make reasonable calls; flag them in code comments or module READMEs so they can be tuned later.

- Orchestrator polling interval (default: 60s).
- Subagent token budget per instruction (default: 2000).
- Max concurrent subagents (default: 5).
- Subagent timeout (default: 5 min per instruction).
- Orchestrator context window — how many past delegation cycles to include (default: last 10).
- Delegation history retention in storage (default: full log per run).
- Error handling on subagent failure (default: log, return error to orchestrator, let orchestrator decide whether to retry or reassign).
- Orchestrator hang detection (default: if no decision output for 10 min, fail the run and log).

## Failure Handling

- If a run fails mid-cycle (orchestrator hangs, inference endpoint dies, game crashes), **do not retry automatically within the 24h window**. Log the failure, commit partial artifacts with status `failed`, surface the failure reason on the leaderboard.
- Every orchestrator gets exactly one 24h attempt per cycle. Fairness > robustness.
- Partial runs still count — if an orchestrator makes $500M before crashing at hour 18, that's the score, with a failure flag.

## Monetization Posture

The project starts **private**. Goes public once validated (at least 2–3 successful runs with different orchestrator models, clean reproducibility). Once public:

- Code: open source.
- Leaderboard: public.
- Run artifacts: public by default. Paying customers may request **anonymous attribution** (their model shows as "Submission A" instead of by name) — this is implemented as a config flag per run.

Do not design monetization features speculatively. If demand emerges, it emerges against a clean research artifact.

## What "Done" Looks Like for the First Milestone

1. The harness can run a single orchestrator + subagent roster against a pinned Bitburner instance for 24 wall-clock hours.
2. Delegation logs, generated scripts, hourly snapshots, and final stats are committed as JSON to a run directory on an orchestrator branch.
3. The aggregator produces a valid leaderboard JSON and basic HTML from one or more branches.
4. Cloudflare Pages can serve the static leaderboard.

Fancy UI, multi-model parallelism, and polish come after this.

## Out of Scope (For Now)

- Real-time leaderboard updates.
- Cross-run subagent learning / fine-tuning.
- Wiki access for subagents.
- Model training.
- Non-Bitburner eval domains.
- Public submission API for third-party models.

Revisit these only after the first milestone is shipped and the benchmark has produced at least one comparable result set.
