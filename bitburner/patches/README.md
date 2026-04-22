# bitburner/patches/

**Status (Milestone 1): empty — no patches needed.**

The spec (SPEC.md §5) anticipates a forked Bitburner with patches for
(a) RNG seed injection and (b) game-to-harness communication. During
Phase 1 planning we discovered both can be done without touching the
Bitburner source:

| Concern           | Approach (no patch)                                        |
|-------------------|------------------------------------------------------------|
| RNG seed          | Puppeteer `page.evaluateOnNewDocument` overrides `Math.random` with a seeded SFC32 PRNG before the app loads. Matches the upstream jest convention in `test/jest/FullSave.test.ts`. |
| Script submission | Remote File API `pushFile` over WebSocket on localhost:12525 |
| State export      | `getSaveFile()` for the full serialized game state (hourly snapshots); a harness-pushed helper script (`home/__state-export.ns`) for per-execution metrics not exposed directly by RFA. |

Because neither hard area needs a fork diff, the `bitburner/`
submodule tracks upstream `bitburner-official/bitburner-src` at the
pinned commit in `BITBURNER_COMMIT` with no divergence.

## When to start patching

Introduce patches here only when an additional capability is both
necessary for the benchmark and unreachable via the above mechanisms.
Document each patch with:

- The file patched in upstream.
- The rationale (what the harness cannot do without it).
- How to re-apply against a newer upstream commit if we ever move the
  pin forward.

At that point, `bitburner/` stops being a pristine tracking clone and
becomes a real fork; we branch it off the pinned SHA and point the
submodule at the fork.
