# harness/

The orchestration harness. A single-process batch job that runs one
orchestrator model against one subagent roster against one Bitburner
instance for `duration_hours`, then commits artifacts.

Entry point: `harness/index.ts` → loads `config/run.yaml`, wires modules,
runs, dumps JSON, commits.

## Module map

| dir            | what                                                    |
|----------------|---------------------------------------------------------|
| `inference/`   | Model adapters (Ollama, HTTP) + registry                |
| `bus/`         | Typed in-memory pub/sub (no external queue)             |
| `storage/`     | SQLite schema + writers + JSON export                   |
| `game/`        | Bitburner integration (Puppeteer, RFA, seed injection)  |
| `subagent/`    | Subagent worker: consumes instructions → inference → results |
| `orchestrator/`| Polling decision loop + prompt template + history comp. |
| `snapshot/`    | Hourly `getSaveFile()` → snapshots channel              |

## Contract invariants

- The orchestrator sees only what SPEC §3.1 allows — no seed, no game
  name, no direct game state beyond snapshots.
- Subagents have no memory across runs; each cycle they receive only
  the instruction.
- All cross-module communication goes through `bus/`. Never call
  modules directly.
