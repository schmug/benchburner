# harness/game/

Bitburner runtime integration. Boots the game, injects the RNG seed,
owns the Remote File API channel, exposes a stable `GameController`
interface to the rest of the harness.

## Why Puppeteer

Upstream Bitburner has no headless Node runtime. The game loop uses
`window.setTimeout` and depends on React + DOM. Puppeteer driving a
headless Chromium against a locally-served build of the pinned commit
is the minimum-invasive path. No fork patches needed.

## Files

| file                  | role                                                |
|-----------------------|-----------------------------------------------------|
| `game.ts`             | `GameController` interface                          |
| `puppeteer.ts`        | Real impl: Chromium boot, RNG inject, RFA lifecycle |
| `rfa.ts`              | Thin WebSocket JSON-RPC client for the RFA          |
| `seed-inject.js`      | Seeded SFC32 `Math.random` override, injected via `evaluateOnNewDocument` before the app loads |
| `state-exporter.ns.ts`| In-game helper script pushed to `home` via RFA; writes `ns.getPlayer()` + server summary to `/__state.json`, readable via `getFile`. |
| `mock.ts`             | Dev-only fake; same interface; not used in scored runs |

## Build output paths (verified on pinned commit a4b0f22a2)

```
bitburner/src/index.html            # served as the page Puppeteer navigates to
bitburner/src/dist/                 # webpack output (~139 MB)
bitburner/src/favicon.ico
bitburner/src/.app/                 # copy used by electron; not needed for harness
```

Build command (from `bitburner/src/`):
`npm install --ignore-scripts && npx webpack --mode production`

The `--ignore-scripts` flag sidesteps upstream's `preinstall` engines
check that demands Node ≥24. Node 22.20 builds cleanly in practice;
only asset-size warnings are produced. If a future pinned commit
actually needs Node 24 at runtime, document here and upgrade.

## Chromium binary

Puppeteer's bundled Chromium is not downloaded (`PUPPETEER_SKIP_DOWNLOAD=true`
at install time; the host sandbox also blocks egress to
storage.googleapis.com). The harness drives the **system Chrome** instead.

`resolveChromeExecutable` in `puppeteer.ts` picks the binary, in order:

1. `PuppeteerGameOptions.chromeExecutable`
2. `PUPPETEER_EXECUTABLE_PATH`
3. a system install from `SYSTEM_CHROME_CANDIDATES` (standard macOS and
   Linux locations)

**So neither env var is required on a machine with Chrome installed.**
Set `PUPPETEER_EXECUTABLE_PATH` only to pin a specific binary — a
non-standard location, or a particular channel.

If nothing is found, boot fails immediately with a message naming the
env var and the paths searched. It used to reach Puppeteer with
`executablePath: undefined`, which sent it hunting for the bundle we
never download and produced:

```
game boot failed: Could not find Chrome (ver. 131.0.6778.204) ...
your cache path is incorrectly configured (which is: ~/.cache/puppeteer)
```

— an error naming a cache directory rather than the remedy, raised two
servers into the boot sequence. Resolution now happens before anything
is bound.

## Chromium flags (for M1 and beyond)

- `--disable-background-timer-throttling`
- `--disable-renderer-backgrounding`
- `--disable-backgrounding-occluded-windows`
- `--no-sandbox` (CI runner friendliness; not needed locally)

## Known risks deferred past M1

- Headless Chromium timer throttling over 24h — revalidate at scale.
- Puppeteer process crash mid-run — logged, no auto-retry (see
  CLAUDE.md § "Failure Handling").

## RNG injection mechanism

Before navigation, `page.evaluateOnNewDocument(seedInjectScript)`
installs an SFC32 PRNG seeded from `config/run.yaml` game.seed,
rebinding `window.Math.random`. All 284 `Math.random()` callsites in
Bitburner route through the override. The seed is never passed in any
form the orchestrator sees.

## State export mechanism

1. `getSaveFile()` (RFA built-in) → full serialized game state for
   hourly snapshots.
2. Harness pushes `dispatcher.js` onto `home` as `/__dispatcher.js` and
   runs it from the terminal; each tick it rewrites `/__state.json`,
   readable via `getFile("/__state.json")` as often as the harness wants.

`/__state.json` from the full dispatcher contains exactly:

| field              | source                                              |
|--------------------|-----------------------------------------------------|
| `current_money`    | `ns.getServerMoneyAvailable("home")` (0.1 GB), floored |
| `augments_installed` | always `[]` — a shape placeholder, not read from the game |
| `last_heartbeat_ms`| `Date.now()`; how `waitForDispatcherAlive` tells a live loop from one that wrote once and died |
| `timestamp`        | ISO string of the same tick                          |

`bitnode_id` and `bitnode_complete` are **deliberately absent**. Reading
them needs `ns.getResetInfo` (1.0 GB) charged against the dispatcher's
permanent per-tick budget for a value that is constant across a run, and
that GB is part of the 1.4 GB reclaimed so subagent scripts can afford
`ns.scp`+`ns.exec` / `ns.purchaseServer`. Instead `puppeteer.ts` reads
bitnode once at boot from a throwaway probe script and merges it into
every `GameState` it hands out (`withCachedFields`) — including the
`read_failed` placeholder and the snapshot embedded in dispatcher result
files, so a consumer never sees the field appear and disappear.

`dispatcher-light.js` (golden / validation mode) does not process the
queue, so it has the headroom to report `bitnode_id` from
`ns.getResetInfo()` itself. The boot probe is skipped in that mode — it
is dispatched through `/__queue.json`, which the light dispatcher never
reads, so it could only ever time out — and the value the light
dispatcher reports is preferred over the cached default.
