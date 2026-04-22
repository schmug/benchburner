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
2. Harness pushes `__state-exporter.ns` onto `home` and runs it; it
   writes `/__state.json` containing `ns.getPlayer().money`,
   bitnode id, augment list, etc. Readable via `getFile("/__state.json")`
   as often as the harness wants.
