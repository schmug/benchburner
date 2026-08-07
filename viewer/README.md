# viewer/

A local, read-only dashboard for watching a run happen: what the
orchestrator is telling each subagent, whether those subagents are
working or failing, and what the game state is doing meanwhile.

```bash
npm run viewer                  # newest run under results/
npm run viewer -- <run_id>      # a specific run
npm run viewer -- path/to/state.db
```

Then open <http://127.0.0.1:8099>. The page polls once a second.
`BENCHBURNER_VIEWER_PORT` and `BENCHBURNER_RESULTS_DIR` override the
defaults.

It works on finished runs too, so it doubles as a viewer for the
artifacts already committed under `results/`.

## Why it reads the database instead of the bus

The harness writes to `results/<run_id>/state.db` continuously —
`insertDelegation` on dispatch, `updateDelegationResult` on return,
`insertScript` / `updateScriptExecution` around each game run,
`insertSnapshot` on the snapshot timer — and opens it in WAL mode
(`harness/storage/db.ts`). A second process can therefore read a run as
it happens.

That matters more than the latency it costs. Tapping `Bus` would mean
subscribing handlers that run **inline and synchronously on the
publisher's stack** (`harness/bus/bus.ts`), inside the process being
measured. A slow handler there stalls the orchestrator loop. Polling a
WAL database from a separate process cannot perturb a scored run at all,
which is the property worth having first. An SSE tap off the bus is a
sensible upgrade later, for sub-second latency and for capturing things
the database never sees.

## Rules this module keeps

**Never write.** `harness/storage/db.ts` applies the schema and runs
`ALTER TABLE` on open, so reusing `openDb` here would make an observer
mutate a scored run's artifact. `reader.ts` opens with
`readonly: true, fileMustExist: true` and touches nothing else. There is
a test that hashes the file before and after reading.

**Never expose the seed.** CLAUDE.md constraint 6 keeps the seed opaque,
and a dashboard is a display surface like any other. `LiveRun`
deliberately has no seed field, and a test asserts the value never
appears anywhere in the serialized view.

**Never trust the text.** Task text, subagent reasoning, `stdout` and
`stderr` are all model- or game-authored. `page.html` builds every node
with `textContent`, never `innerHTML`.

**Show half-finished rows.** A delegation carries `result = NULL` between
dispatch and return; a script carries `execution_result = NULL` until it
runs. Those are exactly the rows worth watching, so they surface as
`pending` rather than being filtered out.

## Two numbers that need care

Both of these are cases where the obvious reading of the artifacts
produces a plausible, wrong number on screen.

- **Tokens.** `runs.orchestrator_tokens` / `subagent_tokens` are flushed
  on a timer, so mid-run they lag delegations that already returned —
  a busy run reads as "0 tokens". The view reports both the recorded
  column and the sum observed across delegations, and the headline takes
  whichever is further along.
- **Cycles.** Only `insertDelegation` persists a cycle number, so a cycle
  that merely spawned or killed a subagent leaves no trace. The view
  reports `latest_delegated_cycle`, never a cycle total — the artifacts
  genuinely do not know how many cycles the orchestrator has run. If you
  want a true cycle count on the page, the orchestrator loop has to
  persist one.

## The decisions feed

The main panel is one entry per orchestrator tick, carrying that tick's
own `reasoning`, with any instructions it dispatched nested underneath.

This is per-cycle rather than per-delegation for a reason that shows up
immediately in practice. On a local qwen2.5-coder:7b run, six cycles
produced **one** delegation — the other five were kill/spawn thrash after
subagent scripts kept failing. A `reasoning` column on `delegations`
would have recorded one of those six decisions and silently dropped the
loop that characterised the whole run.

Cycles recorded before this table existed show as "this run predates
cycle recording"; the delegation feed still renders.

## Not done here

- **No leak scrubbing on display.** `detectLeaks` exists to stop
  forbidden tokens reaching the *model*; showing them to the operator on
  localhost leaks nothing, and hiding them would obscure debugging
  information. **If this page is ever exposed beyond localhost or put on
  a stream, that decision has to be revisited** — it renders raw
  model-authored text.
- The server binds `127.0.0.1` only, and there is no authentication.
