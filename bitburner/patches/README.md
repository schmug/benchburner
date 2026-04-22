# bitburner/patches/

Minimal diffs applied to the pinned upstream Bitburner commit before
each build. The harness re-applies these at build time; the
`bitburner/src` submodule itself stays pinned to upstream, and the
applied-state shows as `-dirty` in `git status` (expected).

## Current patches

### `0001-rfa-harness-port.patch`

**What:** Adds ~10 lines to `src/index.tsx` that read
`globalThis.__BENCHBURNER_RFA_PORT` at boot; if set to a valid port,
sets `Settings.RemoteFileApiPort` and
`Settings.RemoteFileApiReconnectionDelay` so the Remote File API
auto-connects to the harness's WebSocket server.

**Why:** RFA is off by default (`Settings.RemoteFileApiPort = 0`).
Enabling it otherwise requires either clicking through the in-game
Options → Remote API UI, or pre-seeding a valid save into IndexedDB
with RFA enabled. Both alternatives are brittle:
  - UI automation depends on React component selectors that upstream
    can refactor.
  - Pre-seeding requires constructing a full save object (hundreds of
    interdependent fields, version-gated migration logic).
This patch is the smallest reliable mechanism, and it's the exact
"state-export bootstrap" the spec (SPEC §5) permits in
`bitburner/patches/`.

**Why not monkey-patch via `evaluateOnNewDocument`:** webpack does not
expose the `Settings` module on `globalThis` in production builds, so
there's no external handle to mutate. A compile-time patch is required.

**Re-applying against a new pinned commit:**
```sh
cd bitburner/src
git checkout <new-sha>
git apply ../patches/0001-rfa-harness-port.patch
# if the patch fails, regenerate it by hand against the new file.
```

## Build

The harness build step does (roughly):
```sh
cd bitburner/src
git checkout "$(cat ../../BITBURNER_COMMIT)"
git apply --check ../patches/*.patch
git apply ../patches/*.patch
npm install --ignore-scripts
npx webpack --mode production
```

Future patches (seed-injection, additional in-game hooks) will land
here one file per concern so the delta against upstream stays
inspectable.
