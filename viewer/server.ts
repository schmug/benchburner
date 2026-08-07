/**
 * Local, read-only web viewer for a benchburner run.
 *
 * Serves a single page that polls `/api/live`, which projects the run's
 * `state.db` through `viewer/reader.ts`. Nothing here touches the
 * harness process or writes to the run's artifacts, so it is safe to
 * point at a scored run in progress.
 *
 * Usage:
 *   npm run viewer                      # newest run under results/
 *   npm run viewer -- <run_id>          # a specific run
 *   npm run viewer -- path/to/state.db  # an explicit database
 *   BENCHBURNER_VIEWER_PORT=8090 npm run viewer
 */

import { createServer } from "node:http";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readLiveView } from "./reader";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE_PATH = path.join(HERE, "page.html");
const DEFAULT_PORT = 8099;

/**
 * Resolves what to open, in order of decreasing explicitness:
 *   - a path to a .db file
 *   - a run id (or path) under `resultsDir`
 *   - the most recently modified `state.db` under `resultsDir`
 *
 * Returns null when there is nothing to show, so the server can start
 * anyway and say so — a viewer that refuses to boot before the first
 * run exists is annoying to use.
 */
export function resolveRunDb(
  target: string | undefined,
  resultsDir: string,
): string | null {
  if (target) {
    if (target.endsWith(".db")) return existsSync(target) ? target : null;
    for (const candidate of [
      path.join(target, "state.db"),
      path.join(resultsDir, target, "state.db"),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  if (!existsSync(resultsDir)) return null;
  const candidates: Array<{ file: string; mtime: number }> = [];
  for (const entry of readdirSync(resultsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(resultsDir, entry.name, "state.db");
    if (!existsSync(file)) continue;
    candidates.push({ file, mtime: statSync(file).mtimeMs });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].file;
}

function main(): void {
  const repoRoot = path.resolve(HERE, "..");
  const resultsDir = process.env.BENCHBURNER_RESULTS_DIR ?? path.join(repoRoot, "results");
  const target = process.argv[2];
  const portEnv = process.env.BENCHBURNER_VIEWER_PORT;
  const port = portEnv ? Number(portEnv) : DEFAULT_PORT;

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`[viewer] invalid BENCHBURNER_VIEWER_PORT=${portEnv}; expected 1-65535`);
    process.exit(1);
  }

  // Re-resolved per request when auto-discovering, so starting the
  // viewer before the run — or leaving it open across runs — works.
  const pinned = target !== undefined;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/api/live") {
      const dbPath = resolveRunDb(target, resultsDir);
      res.setHeader("cache-control", "no-store");
      res.setHeader("content-type", "application/json");
      if (!dbPath) {
        res.writeHead(200);
        res.end(JSON.stringify({ error: "no run found", results_dir: resultsDir }));
        return;
      }
      try {
        res.writeHead(200);
        res.end(JSON.stringify(readLiveView(dbPath)));
      } catch (e) {
        // A run that is mid-write, or a db being created right now, is
        // normal. Report it and let the page retry on its next tick.
        res.writeHead(200);
        res.end(JSON.stringify({ error: (e as Error).message, db: dbPath }));
      }
      return;
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(readFileSync(PAGE_PATH, "utf8"));
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  server.listen(port, "127.0.0.1", () => {
    const initial = resolveRunDb(target, resultsDir);
    console.log(`[viewer] http://127.0.0.1:${port}`);
    console.log(`[viewer] results dir: ${resultsDir}`);
    console.log(
      initial
        ? `[viewer] watching: ${initial}${pinned ? "" : " (newest; re-checked each poll)"}`
        : `[viewer] no run found yet — start one and the page will pick it up`,
    );
  });
}

// Only run the server when invoked directly, so tests can import
// resolveRunDb without binding a port.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
