# harness/snapshot/

Fires at the top of every wall-clock hour (H=0..24). Pulls
`getSaveFile()` via RFA, distills it into the `game_state` shape from
SPEC §2.4, publishes a `snapshots` message, and lets storage persist.

## Distillation

The raw `getSaveFile()` payload is large (the entire serialized game
state). We extract only:

- `current_money`
- `bitnode_id`, `bitnode_complete`
- `augments_installed[]`
- any secondary observable stats we want on the leaderboard

The raw save is *not* persisted; only the distilled JSON lands in
`snapshots` table. Raw save inspection is a post-mortem tool we can
rebuild later if needed.

## Timing

Uses a setTimeout chain keyed off run start, not `setInterval`, to
avoid drift. Hour 0 snapshot happens at run start before the
orchestrator's first cycle so the first decision has initial state to
reason over.
