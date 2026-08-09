# Restore the Decision Space — Build DAG and Status Ledger

Execution companion to
[2026-08-09-restore-decision-space.md](2026-08-09-restore-decision-space.md).
That document says *what to build*; this one says *what can run in
parallel*, *what already shipped*, and *what the reviews found*.

Keep this current. Its whole purpose is that no session has to hold the
build in its head.

---

## Status

| node | scope | status | verdict | evidence |
|---|---|---|---|---|
| **N1** game-ram | reclaim 1.4 GB from the dispatcher | **shipped** (#37) | FAIL → fixed → resolved by composition¹ | `5.2→3.8 GB`, free `2.8→4.2 GB`, measured with `ns.getScriptRam`; boot `186.3s→5.9s` |
| **N2** docs-module | vendor the game's basics into the prompt | **shipped** (#37) | FAIL → fixed → resolved by owner decision² | 92/92 with **no submodule**; 5 docs sha256-identical to the pin |
| **N3** spec-docs | SPEC + VALIDATION | **shipped** (#37) | **PASS** | 6 numeric claims re-derived from primary sources, all exact |
| **N4** lifecycle | `replace`, `kill`-stops-script, per-subagent earnings | **not built** | — | issue filed |
| **N5** money-delta | `starting_money` / `money_earned` | **not built** | — | issue filed |
| **N6** doc-library | in-world `/doc/*.txt` | **not built** | — | issue filed |
| **N7** e2e | does the space get *used*? | running | — | reduced scope: only prediction 2 is live until N4+N5 land |

¹ N1's blocking finding was `prompt.ts` stating the old budget — fixed on
N2's branch. Neither branch alone was correct; only the composition.
² N2's blocker was that the vendored manual leaked 28 game-identifying
markers past the name scrub. Resolved by retiring the scrub (CLAUDE.md
constraint 3 revised); seed opacity deliberately retained.

---

## The parallelism constraint — read before dispatching

**The remaining three nodes cannot run in parallel.** They were
decomposed by *concern*, not by *file*, and converge on the same modules:

| file | N4 | N5 | N6 |
|---|---|---|---|
| `harness/types.ts` | ✓ | ✓ | |
| `harness/orchestrator/loop.ts` | ✓ | | |
| `harness/orchestrator/prompt.ts` | | ✓ | ✓ |
| `harness/game/puppeteer.ts` | ✓ | ✓ | ✓ |
| `harness/game/dispatcher.js` | ✓ | | |

Every pair shares at least `puppeteer.ts`. Dispatching them concurrently
produces conflicts, not throughput.

**Order: N4 → N5 → N6.** N4 first because it is the largest and carries
the `replace` fix; N6 last because it depends on N2's `docs.ts` (shipped)
and touches the smoke test N1 created.

Wave 1 achieved 3-way parallelism only because N1/N2/N3 were genuinely
file-disjoint. Do not assume that generalises.

---

## Environment tiers — worktrees start empty

Verified by probe: a fresh `git worktree` has `bitburner/src` **empty**
(submodules are not checked out) and `node_modules` **absent**.

| tier | needs | setup | nodes |
|---|---|---|---|
| **A** | `npm install` | ~2 min | N4, N5 |
| **B** | + submodule checkout, no build | ~4 min | — (N2 was B; its docs are now vendored) |
| **C** | + patch + `npm install --ignore-scripts` + `npx webpack` (139 MB) | ~10 min | N6, N7 |

Tier-C nodes should run where the game is already built rather than
paying webpack three times in parallel — concurrent builds also contend
for the CPU that RAM measurements depend on.

---

## Reviewer mandate (reusable)

Every node gets a reviewer that did not write it, and reviewers must
**run** commands. In Wave 1 every node failed its first review, and none
of the findings were reachable by the local gates.

- **(a) CSS specificity / inheritance.** Not applicable to any node that
  does not touch `viewer/page.html`. Confirm via `git show --stat` and
  say so — do not manufacture a finding to fill the slot.
- **(b) Key-normalization / dedup.** Live risk: `live_scripts` keyed by
  `subagent_id`, `evictionTargets` matching on it, `replaceByInstruction`
  keyed by `instruction_id`. Check case/whitespace variants, a re-spawned
  subagent reusing an id, and a subagent whose script died.
- **(c) Misused API / runtime-only failure.** The highest-yield class
  here. Every `ns.*` call in `dispatcher.js` is validated only inside the
  running game; a typo typechecks and fails silently. **Bitburner
  computes script RAM statically over the whole file** — one surviving
  reference, even inside `if (false)`, re-charges the full cost.
- **(d) Stale tests / fixtures after removal.** Anything asserting
  behaviour the change retired.
- **(e) Claims not enforced by a check.** The load-bearing class. For
  every quantitative claim in a commit message, name the enforcing check
  or report it unenforced.

A node is accepted only on reviewer **PASS**.

---

## Corrections already applied to the plan

The implementation plan contained four defects, all found by agents
executing it. They are fixed in the plan; recorded here so they are not
reintroduced.

1. **Undercounted call sites.** Task 1 said four `ns.getPlayer()` calls
   in `main`. There are five, plus a second `ns.getResetInfo()`, in
   `writeResult`. Because RAM is computed statically over the file,
   following the plan literally measured **5.3 GB — worse than the 5.2 GB
   baseline**, with every diff line looking correct.
2. **`ns.tprint` never reaches `stdout`.** `ExecutionResult.stdout` comes
   from `stats.logs`, which only `ns.print` writes. Probes using `tprint`
   parse nothing and look exactly like the defect they measure.
3. **TDZ error.** `const BASICS_TEXT = ...` placed above the
   `FORBIDDEN_TOKENS` it transitively depended on.
4. **`as const` typing.** Produced a literal-tuple type that broke
   `.includes()` in the plan's own test.

Also corrected: the design spec estimated the post-fix dispatcher at
~3.6 GB; the measured value is **3.8 GB**.

---

## Known gaps, filed

| issue | gap |
|---|---|
| [#38](https://github.com/schmug/benchburner/issues/38) | Nothing enforces that vendored docs still match the pin. They go verbatim into every prompt; if `BITBURNER_COMMIT` moves, the manual silently describes a different game. |
| [#39](https://github.com/schmug/benchburner/issues/39) | The 4.2 GB budget is a hand-maintained literal in three places — exactly how `prompt.ts` got missed. Also a live 4.0-vs-4.2 skew between the guard and the prompts. |
| [#40](https://github.com/schmug/benchburner/issues/40) | `smoke:ram-budget` is wired only into `run.yml`, which is `workflow_dispatch`-only. A PR regressing dispatcher RAM merges green. |
| [#36](https://github.com/schmug/benchburner/issues/36) | `npm run build` does not copy `schema.sql` into `dist/`. The vendored `.md` docs have the same problem; both are masked by a pre-existing extensionless-ESM break. |

Unfiled and deliberately descoped: three of the six RAM figures in the
orchestrator prompt (the per-call 2.9 / 3.5 / 3.85) are pinned by no
test — folded into #39.

---

## Open questions the build cannot answer

- **Does the strategy space get used?** N7's live prediction. If runs
  still converge on a single-host hack loop, the next suspects are loop
  latency and the canonical duration, not anything in this plan.
- **Is four closed loops enough to measure anything?** A full
  instruct→code→commit→observe cycle measures ~300s, so a 20-minute run
  closes ~4. This plan makes each feedback event informative; it does not
  make them more frequent. That is the other half of the problem and is
  an explicit non-goal throughout.
