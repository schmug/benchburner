# harness/storage/

SQLite-backed run state. One `results/<run_id>/state.db` per run.
Schema per SPEC §4. At run end, writers dump JSON exports beside the
DB for Git-friendly diffs and aggregator consumption.

## Files

| file         | role                                                   |
|--------------|--------------------------------------------------------|
| `schema.sql` | Tables (runs, delegations, scripts, snapshots)         |
| `db.ts`      | `better-sqlite3` wrapper, migration on open            |
| `writers.ts` | One insert function per table + finalize(run_id, …)    |
| `export.ts`  | Dump summary/delegations/scripts/snapshots JSON files  |

## JSON export shapes

- `summary.json` → SPEC §8 leaderboard-entry shape (so aggregator is
  trivial).
- `delegations.json` → array of `{instruction, result}` pairs, oldest
  first.
- `scripts.json` → array of full Netscript sources with execution
  metadata.
- `snapshots.json` → array of hourly `{hour, game_state, timestamp}`.

## Defaults

- Full delegation retention (no pruning). M1 only runs an hour; space
  is not a concern.
- Single-writer: the harness process. No concurrent DB access from
  subagent workers; they push through the bus and storage subscribes.
