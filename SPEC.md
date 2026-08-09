# SPEC.md — Technical Specification

> Read `CLAUDE.md` first. This document assumes the intent and constraints defined there.

## 1. System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        Run Harness                           │
│                                                               │
│  ┌──────────────┐   instructions   ┌──────────────────┐     │
│  │ Orchestrator │ ───────────────> │ In-Memory Bus    │     │
│  │   (1 model)  │ <─────────────── │                  │     │
│  └──────┬───────┘     results      └────────┬─────────┘     │
│         │                                    │               │
│         │ periodic snapshots                 │ dispatch      │
│         │ + game exec results                ▼               │
│         │                          ┌──────────────────┐     │
│         │                          │   Subagent Pool  │     │
│         │                          │ (N models, async)│     │
│         │                          └────────┬─────────┘     │
│         │                                    │               │
│         │                                    │ code          │
│         │                                    ▼               │
│         │                          ┌──────────────────┐     │
│         └─────────────────────────>│ Bitburner Game   │     │
│           reads game state          │ (pinned, headless│     │
│                                     │  fork, seed=XYZ) │     │
│                                     └────────┬─────────┘     │
│                                              │               │
│                                              ▼               │
│                                     ┌──────────────────┐     │
│                                     │ SQLite + JSON    │     │
│                                     │ Artifacts        │     │
│                                     └──────────────────┘     │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼ (at cycle end)
                   git commit to orchestrator/<model> branch
                            │
                            ▼ (daily)
                    Aggregator → results-published → Pages
```

## 2. Message Contracts

All messages pass through the in-memory bus. Every message carries `instruction_id` (or `snapshot_id` / `script_id`) and an ISO-8601 `timestamp`.

### 2.1 Orchestrator → Subagent (Instruction)

```json
{
  "instruction_id": "uuid",
  "subagent_id": "string",
  "task": "string",
  "context": "string",
  "constraints": {
    "token_budget": 2000,
    "max_script_size_lines": 200
  },
  "timestamp": "2026-04-22T14:00:00Z"
}
```

- `task`: high-level goal in natural language ("generate a script that maximizes early-game money via hacking n00dles").
- `context`: whatever the orchestrator wants the subagent to know — prior feedback, game state summary, strategic direction. **Not** raw game state; the orchestrator synthesizes.
- `token_budget` and `max_script_size_lines`: hard limits the subagent must respect.

### 2.2 Subagent → Orchestrator (Result)

```json
{
  "instruction_id": "uuid",
  "subagent_id": "string",
  "status": "success | error | timeout",
  "code": "string (Netscript source, present iff status=success)",
  "reasoning": "string (optional, subagent's explanation)",
  "tokens_used": 1823,
  "error_message": "string (present iff status=error)",
  "iterations": 2,
  "iteration_summaries": [
    { "iteration": 1, "exit_reason": "errored", "money_gained": 0, "stderr": "..." },
    { "iteration": 2, "exit_reason": "exited", "money_gained": 45000 }
  ],
  "timestamp": "2026-04-22T14:03:12Z"
}
```

`iterations` and `iteration_summaries` are present when the subagent
ran the agentic write-run-observe loop (see §2.5). The orchestrator
sees only the final committed code, not the intermediate probe code —
the iterative refinement is the subagent's own tool-use within a
single instruction.

### 2.3 Backend → Orchestrator (Game Execution Result)

Emitted after the harness runs a subagent-generated script in the game.

```json
{
  "script_id": "uuid",
  "subagent_id": "string",
  "status": "executed | failed",
  "money_gained": 5000000,
  "time_elapsed_seconds": 620,
  "error": "string (if failed)",
  "stdout": "string (ns.print/ns.tprint buffer, truncated to last ~8KB)",
  "stderr": "string (runtime error, kill reason, or harness error)",
  "exit_reason": "exited | errored | killed | timed_out | failed_to_start | harness_error",
  "script_stats": {
    "online_running_time_seconds": 12.4,
    "online_exp_gained": 340,
    "online_money_made": 5000000,
    "ram_usage": 4.2,
    "threads": 1
  },
  "game_state_snapshot": {
    "current_money": 5200000,
    "bitnode_id": 1,
    "bitnode_complete": false
  },
  "timestamp": "2026-04-22T14:13:32Z"
}
```

`stdout` / `stderr` / `exit_reason` / `script_stats` are the normal
dev-loop feedback a coding team has. Giving them to the subagent
during its agentic loop (§2.5) and to the orchestrator via the final
result keeps the benchmark measuring orchestration, not
debugging-blind.

### 2.5 Subagent agentic loop

Each instruction triggers a bounded write-run-observe loop inside the
subagent. On each turn the subagent receives the task + any prior
iterations' execution feedback and emits JSON of the form:

```json
{
  "decision": "RUN" | "DONE",
  "code": "<full script source>",
  "notes": "<optional short rationale>"
}
```

- `RUN`: the harness runs the code against the GameController, reads
  the enriched `ExecutionResult`, and feeds it back as the next turn's
  context. Probe runs use a throw-away `script_id` so they don't
  collide with the orchestrator-submitted committed script record.
- `DONE`: commits the code as the final `Result.code` the orchestrator
  will see. No further inference calls for this instruction.

Bounded by `max_iterations` (default 3) and
`token_budget_per_instruction` per turn. On iteration-budget
exhaustion the last code is committed.

This shape is deliberately close to how modern coding agents work
(write → run → observe → iterate) so the benchmark measures the
orchestrator's ability to direct *agentic* coding subagents, not
one-shot completion subagents.

### 2.4 Backend → Orchestrator (Periodic Snapshot)

Emitted 24 times per run, at `duration / 24` intervals (floored at 30s)
— so hourly on a 24h endurance run, every 50s on a canonical 20-minute
run. The `hour` field is a snapshot index (0..24), not a wall-clock
hour; it kept its name because the storage column and existing run
artifacts use it.

The cadence is proportional rather than fixed because a hardcoded
one-hour interval reduced every sub-hour run to a single index-0
snapshot, removing the orchestrator's second information channel
entirely while appearing to work.

```json
{
  "source": "backend_snapshot",
  "hour": 3,
  "game_state": {
    "current_money": 50000000,
    "bitnode_id": 1,
    "bitnode_complete": false,
    "augments_installed": ["NeuroFlux Governor"]
  },
  "timestamp": "2026-04-22T17:00:00Z"
}
```

## 3. Orchestrator Decision Loop

Invoked every `polling_interval_seconds` (default 60).

### 3.1 Input to Orchestrator Model

```json
{
  "cycle_number": 42,
  "elapsed_time_seconds": 10800,
  "total_duration_seconds": 86400,
  "game_state": {
    "starting_money": 1262,
    "money_earned": 0,
    "current_money": 50000000,
    "bitnode_id": 1,
    "bitnode_complete": false,
    "augments_installed": []
  },
  "subagent_status": [
    {
      "subagent_id": "mistral-7b-instance-1",
      "last_instruction_id": "uuid",
      "last_result": { /* Result object, or null if pending */ },
      "last_execution": {
        /* Outcome of this subagent's most recent COMMITTED script.
           Null until one has run. Distinct from
           last_result.iteration_summaries, which covers the probe runs
           inside the subagent's own write-run-observe loop. */
        "status": "executed | failed",
        "exit_reason": "running | failed_to_start | exited | errored | timed_out | killed | replaced",
        "money_gained": 0,
        "time_elapsed_seconds": 0,
        "stdout": "truncated",
        "stderr": "truncated",
        "script_stats": { "ram_usage": 2.6 },
        "timestamp": "2026-04-22T14:13:32Z"
      },
      "live_script": {
        /* This subagent's committed scripts while they run, totalled.
           Null if none. last_execution says whether a script STARTED;
           this says whether it is still EARNING. */
        "running": true,
        "money_made": 45000,
        "ram": 2.6,
        "uptime_seconds": 180,
        "scripts": 1
      },
      "status": "idle | pending | executed"
    }
  ],
  "delegation_history": [
    /* last N (default 10) { instruction, result } pairs, compact */
  ],
  "available_subagent_models": ["llama-3-8b", "mistral-7b", "qwen-2.5-coder-7b"]
}
```

`available_subagent_models` is the per-run curated roster. The orchestrator can only spawn from this list.

`last_execution` closes a gap between this schema and §3.3's system
prompt, which has always told the orchestrator that "execution feedback
includes stdout / stderr / exit_reason / money_gained". It received that
only for the subagent's *probe* iterations; the outcome of the script
actually committed to the game was discarded, so a script that never
started was indistinguishable from one that was earning. Free-text
fields are leak-scrubbed and truncated like every other channel.

Two `exit_reason` values are produced by the lifecycle verbs rather than
by the script itself: `killed` (the orchestrator killed the subagent, so
the harness stopped its committed script) and `replaced` (an `instruct`
with `replace: true` retired it once the successor was confirmed
running). Both are visible to the orchestrator so a script that stopped
on its instruction is distinguishable from one that crashed.

`live_script` answers a different question than `last_execution`:
`last_execution` says whether an instruction produced a script that
*started*; `live_script` says whether it is still *earning* right now.
It is `null` when the subagent has no committed script running, not a
fake zero. `money_made` is those scripts' own earnings, not a global
player-money delta, so it stays attributable when several subagents run
scripts at once.

Its figures are **totals across every committed script that subagent has
running**, with `scripts` giving the count, because `replace` defaults to
false and a subagent owning several running scripts is the ordinary case
rather than an edge one. `ram` is therefore how much of the shared home
budget that subagent holds, and `uptime_seconds` is its oldest surviving
script. Reporting a single script per subagent would understate earnings
in exactly the situation the default produces.

Every game starts the player with a nonzero balance ($1,262 in BitNode
1). `current_money` is that absolute balance and stays for backward
compatibility with published run artifacts; `starting_money` is the
balance captured once at boot, and `money_earned` (`current_money -
starting_money`) is the orchestrator's actual score. A run that has
earned nothing shows `money_earned: 0` even though `current_money` still
reads $1,262 — the starting balance is a given, not an achievement.

### 3.2 Output from Orchestrator Model

```json
{
  "actions": [
    {
      "action_type": "spawn | kill | instruct | noop",
      "subagent_id": "string (for kill/instruct; generated by harness for spawn)",
      "model_choice": "string (only for spawn, must be in available_subagent_models)",
      "replace": "boolean (optional, instruct only; default false)",
      "instruction": { /* Instruction object, only for instruct */ }
    }
  ],
  "reasoning": "string (free-form, logged but not scored)"
}
```

A cycle may emit zero or more actions. `noop` is a valid single action if the orchestrator decides nothing should change.

`replace` is optional and applies only to `instruct`; it defaults to
`false`. When an `instruct` action's subagent already has a committed
script running, the new script it produces runs *alongside* the old one
by default — it does not touch it. Setting `replace: true` retires the
old script, but only *after* the new one is confirmed running, so a
replacement that fails to start cannot cost the income it was meant to
preserve. `kill` always stops a subagent's committed script along with
the subagent itself; there is no separate "keep the script, retire the
worker" verb.

### 3.3 Orchestrator Prompt Template (Skeleton)

The harness wraps each cycle's input JSON in a system + user prompt. The exact wording (other than the `{N}-hour window` substitution below) should be fixed across all benchmarked models for fairness. `{N}` is replaced at prompt-build time with the run's effective duration in hours: integer for whole-hour runs; otherwise up to 2 decimal places, trailing zeros trimmed. Cross-run comparisons are only meaningful when `duration_hours` matches.

```
SYSTEM: You are the orchestrator of a team of subagent coders. You cannot
play the game yourself. You cannot edit the code your subagents write.
Your job is to decide which subagents to spawn, which to kill, and what
instructions to give them. Your team is playing a game. Your goal is to
maximize the team's in-game money in the {N}-hour window.

You can only observe what your subagents report back, plus periodic game
state snapshots from the backend. You have no other visibility.

Respond ONLY with a JSON object matching the output schema. No prose
outside the JSON.

USER:
<serialized input JSON here>
```

**Do not leak**: the pinned RNG seed, the game being Bitburner specifically (the orchestrator should treat it as an abstract game — this prevents wiki-style memorized strategies leaking through model priors), or the scoring rubric beyond "maximize money."

> Note: total leak-proofing of "Bitburner" is likely impossible (the Netscript API is distinctive). Intent is not to hide it in code, just not to name it in the prompt.

**The system prompt carries the game's own Basic Mechanics documentation, verbatim.** Five files (~2,682 words: `basic/ram.md`, `basic/servers.md`, `basic/hacking.md`, `basic/scripts.md`, `basic/programs.md`) are concatenated into the SYSTEM message unmodified, wording fixed and identical across every benchmarked model. This is mechanics — that servers form a network, that RAM can be bought or borrowed, that programs open ports — not strategy, and it lives in the cached system prompt rather than the per-cycle user message. Using the game's own text rather than an authored briefing removes both authoring bias and the fairness gap between models that happen to have absorbed more wiki content during pretraining than others.

Deliberately excluded from the system prompt: `help/getting_started.md` (the tutorial, which walks through a working early-hack script) and `programming/hackingalgorithms.md` (the optimal HWG-batching guide). Both are strategy, not mechanics, and handing them over in the prompt would hand over a strategy rather than a manual. Instead they are pushed in-world at boot as `/doc/*.txt` files on `home`, plus a `/doc/index.txt` listing them, readable by a subagent for 0 GB of RAM but only if the orchestrator spends a subagent round trip sending one and reporting back — making "should I send someone to read the manual?" a real orchestration decision with a real opportunity cost, rather than a freebie in the prompt.

## 4. Data Model (SQLite)

All tables live in a single SQLite file per run: `results/<run_id>/state.db`.

### 4.1 `runs`

| column | type | notes |
|---|---|---|
| run_id | TEXT PK | uuid |
| orchestrator_model | TEXT | e.g. `llama-3-70b` |
| orchestrator_config | TEXT | JSON: inference endpoint, context window, etc. |
| subagent_roster | TEXT | JSON array of model IDs allowed this run |
| seed | INTEGER | pinned RNG seed (stored but not exposed to orchestrator) |
| bitburner_commit | TEXT | pinned fork commit SHA |
| start_time | TEXT | ISO-8601 |
| end_time | TEXT | ISO-8601 or null if failed |
| final_money | INTEGER | primary score |
| final_stats | TEXT | JSON: BitNodes cleared, augments, etc. |
| status | TEXT | `completed` / `failed` / `in_progress` |
| failure_reason | TEXT | null unless status=failed |
| attribution_mode | TEXT | `public` / `anonymous` |

### 4.2 `delegations`

| column | type | notes |
|---|---|---|
| delegation_id | TEXT PK | uuid |
| run_id | TEXT FK | |
| cycle_number | INTEGER | |
| action | TEXT | JSON (orchestrator output action) |
| subagent_id | TEXT | |
| instruction_id | TEXT | |
| result | TEXT | JSON (subagent result), null if still pending |
| timestamp | TEXT | |

### 4.3 `scripts`

| column | type | notes |
|---|---|---|
| script_id | TEXT PK | |
| run_id | TEXT FK | |
| subagent_id | TEXT | |
| instruction_id | TEXT FK | |
| code | TEXT | full Netscript source |
| executed_in_game | INTEGER | bool |
| execution_result | TEXT | JSON |
| tokens_used | INTEGER | |
| timestamp | TEXT | |

### 4.4 `cycles`

One row per orchestrator tick — including ticks that produce no delegation.

| column | type | notes |
|---|---|---|
| run_id | TEXT FK | part of PK |
| cycle_number | INTEGER | part of PK |
| status | TEXT | `ok` / `malformed` / `failed` |
| reasoning | TEXT | the orchestrator's own §3.2 `reasoning`; null if the model gave none |
| actions | TEXT | JSON array of the cycle's actions |
| tokens_used | INTEGER | orchestrator inference for this cycle |
| latency_ms | INTEGER | wall-clock for this cycle |
| error | TEXT | null unless status ≠ ok |
| timestamp | TEXT | ISO-8601 |

`reasoning` is logged, not scored (§3.2). It lives here rather than on
`delegations` because it is per-cycle: a cycle that noops, only
spawns/kills, returns malformed JSON, or throws writes **no** delegation
row, and those are frequently the cycles most worth explaining. Recording
the tick itself also gives readers a true cycle count — `delegations`
alone only reveals the highest cycle that happened to delegate.

### 4.5 `snapshots`

| column | type | notes |
|---|---|---|
| snapshot_id | TEXT PK | |
| run_id | TEXT FK | |
| hour | INTEGER | 0..24 |
| game_state | TEXT | JSON |
| timestamp | TEXT | |

### 4.6 JSON Exports

At run end, the SQLite file is dumped to human-readable JSON files beside it for Git-friendly diffs and Pages consumption:

```
results/<run_id>/
├── state.db
├── summary.json          # { run_id, model, final_money, stats, status }
├── delegations.json      # full delegation log
├── scripts.json          # all generated scripts
├── snapshots.json        # periodic snapshots (24 per run)
└── cycles.json           # every orchestrator tick + its reasoning
```

## 5. Bitburner Integration

### 5.1 Fork

- Forked from [bitburner-official/bitburner-src](https://github.com/bitburner-official/bitburner-src).
- Pinned to a specific commit (record SHA in `runs.bitburner_commit` and in repo `BITBURNER_COMMIT` file).
- No rebasing against upstream during the benchmark's active lifetime. Stability > features.

### 5.2 Runtime

- Headless Node.js runtime (no Electron UI). Use existing community headless builds as reference.
- Real-time; no tick acceleration. Wall-clock time = in-game time.
- RNG seed pinned via fork-level patch to make the seed injectable at boot.

### 5.3 Script Execution Interface

The harness needs a way to:

1. **Submit a script**: write Netscript to the game's filesystem, tag with `script_id`.
2. **Run a script**: invoke it in-game, capture exit code, runtime, errors.
3. **Read game state**: pull current money, bitnode ID, augments, faction standings. Used for hourly snapshots and post-execution results.

Use the game's existing Remote File API where possible. Patch the fork only where necessary (seed injection, state export). Keep patches in a clearly-named directory (`bitburner/patches/`) with rationale comments.

## 6. Inference Abstraction

All model calls — orchestrator and subagents — go through one adapter interface:

```typescript
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

Default adapters to ship:

- **OllamaAdapter** (default; local, offline).
- **HTTPAdapter** (generic OpenAI-compatible endpoint — covers vLLM, Together, HF Inference, etc.).

Adding a new model does **not** require code changes. It requires a config entry:

```yaml
# config/models.yaml
- id: llama-3-70b
  adapter: ollama
  endpoint: http://localhost:11434
  context_window: 8192
- id: qwen-2.5-coder-7b
  adapter: http
  endpoint: https://api.together.xyz/v1/chat/completions
  api_key_env: TOGETHER_API_KEY
  context_window: 32768
```

## 7. Run Lifecycle

1. **Init**: load run config (orchestrator model, subagent roster, seed). Create `run_id`. Initialize SQLite. Boot pinned Bitburner instance.
2. **Warm-up** (< 1 min): orchestrator gets an initial empty-state input, can spawn first subagents.
3. **Main loop** (the configured duration): polling loop fires orchestrator decisions every 60s. Subagents run async. Scripts execute in-game as they arrive. Snapshots emit at `duration / 24`.
4. **Shutdown**: at end of duration, freeze the bus. Let in-flight subagent calls timeout within 5 min. Dump final game state. Export JSON artifacts. Commit to orchestrator branch.

## 8. Aggregator

- Runs daily (GitHub Action on schedule).
- Checks out each `orchestrator/*` branch, reads the latest `results/<run_id>/summary.json`.
- Builds `leaderboard.json`:

```json
{
  "generated_at": "ISO-8601",
  "seed": "hash of pinned seed for verification",
  "bitburner_commit": "abc123",
  "entries": [
    {
      "rank": 1,
      "orchestrator_model": "llama-3-70b",
      "attribution": "public",
      "final_money": 2500000000,
      "bitnodes_completed": 1,
      "augments_installed": 5,
      "status": "completed",
      "run_id": "uuid",
      "branch": "orchestrator/llama-3-70b",
      "artifact_url": "relative link into pages/"
    }
  ]
}
```

- Generates static HTML pages for `results-published` branch.
- `attribution: "anonymous"` entries render as `"Submission A"`, `"Submission B"`, etc.

## 9. Pages Output

Static site structure:

```
pages/
├── index.html             # leaderboard
├── leaderboard.json       # machine-readable
├── runs/
│   └── <run_id>/
│       ├── index.html     # run detail: delegation transcript, scripts, timeline
│       ├── summary.json
│       ├── delegations.json
│       ├── scripts.json
│       └── snapshots.json
└── about.html             # spec + methodology link
```

Frontend design (Claude Design task, not Claude Code's) will render these. The harness just needs to guarantee the JSON shapes above.

## 10. Configuration Files

### 10.1 `config/run.yaml` (per-run)

```yaml
run_id: auto
orchestrator:
  model: llama-3-70b
  adapter_config_ref: models.llama-3-70b
  polling_interval_seconds: 60
  history_window: 10
subagent_roster:
  - llama-3-8b
  - mistral-7b
  - qwen-2.5-coder-7b
subagent_limits:
  max_concurrent: 5
  token_budget_per_instruction: 2000
  timeout_seconds: 300
game:
  bitburner_commit: abc123def
  seed: 8675309          # opaque to orchestrator
duration_minutes: 20     # canonical; or duration_hours: 24 for endurance
attribution_mode: public  # or 'anonymous'
```

**Duration.** Exactly one of `duration_minutes` or `duration_hours` is
required; supplying both or neither is a load error. The canonical
ranked duration is 20 minutes (`duration_minutes: 20`); `duration_hours:
24` selects the separate endurance measurement. See CLAUDE.md
§ "Run durations: canonical vs endurance" — the two never share a
leaderboard column.

Requiring exactly one key is deliberate. When only `duration_hours`
existed, the 20-minute canonical duration was unreachable from config
and every battery reached it via `BENCHBURNER_DURATION_SEC`, a dev-only
env override — so every PCS1/PDS6 config claimed `duration_hours: 1`
while its runs lasted 1200s, and the artifacts recorded the config's
lie rather than what ran.

**Optional `snapshot_interval_seconds`.** Overrides the snapshot
cadence, which otherwise defaults to `duration / 24` (floored at 30s).
Must be > 0 and must not exceed the run duration. Setting it makes a run
incomparable to runs that did not set it, since it changes what the
orchestrator can observe.

### 10.2 `config/models.yaml`

See §6.

## 11. CI / Deployment

### 11.1 Run Trigger

- Manual dispatch or scheduled (daily per branch). GitHub Action on a self-hosted runner.
- Workflow: checkout branch → load run config → execute harness → commit artifacts → push.

### 11.2 Aggregator Trigger

- Scheduled daily after expected run completion.
- Fan-out: read all `orchestrator/*` branches, aggregate, push to `results-published`.
- `results-published` deploys to Cloudflare Pages automatically.

## 12. Open Implementation Questions

Claude Code should resolve these during build and note resolutions in the relevant module README:

- Exact mechanism for RNG seed injection into Bitburner (fork patch location).
- Whether subagent inference runs in-process or as a separate worker pool.
- Error budget: how many subagent errors before orchestrator is warned the model might be broken?
- Compression strategy for `delegation_history` to stay within orchestrator context window over long runs.

## 13. First Milestone Acceptance Criteria

A single invocation of the harness with:
- one orchestrator (e.g. `llama-3-70b`),
- one subagent in the roster (e.g. `qwen-2.5-coder-7b`),
- duration reduced to 1 hour for smoke testing,

produces:
- a populated SQLite DB,
- valid JSON exports,
- a `summary.json` with a real (possibly small) `final_money` value,
- no orchestrator prompt leakage of seed or game identity,
- a git commit on the test branch.

Once this passes, scale to 24h and add a second orchestrator.
