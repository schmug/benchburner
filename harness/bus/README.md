# harness/bus/

Typed in-memory pub/sub. No external queue. Single process.

## Channels

| channel        | publisher       | subscribers                             |
|----------------|-----------------|-----------------------------------------|
| `instructions` | orchestrator    | subagent workers                        |
| `results`      | subagent workers| orchestrator, storage                   |
| `executions`   | game            | orchestrator, storage                   |
| `snapshots`    | snapshot timer  | orchestrator, storage                   |

All messages conform to the contracts in `harness/types.ts` (mirrored
from SPEC §2).

## Design notes

- Synchronous delivery by default. Handlers that do async work must
  manage their own promises; the bus does not await them.
- No persistence. If a subscriber crashes, replay is not supported.
  Storage persists everything that flows through, so the on-disk
  record is the durable log.
- `freeze()` stops further publishes; used during shutdown so in-flight
  subagent calls can drain without the orchestrator issuing more.
