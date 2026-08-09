/**
 * The harness installs Puppeteer with PUPPETEER_SKIP_DOWNLOAD=true and
 * drives the system Chrome instead, so Puppeteer's bundled Chromium is
 * deliberately absent. If nothing supplies an executable path, Puppeteer
 * goes looking for that missing bundle and fails with:
 *
 *   Could not find Chrome (ver. 131.0.6778.204) ... cache path
 *   (which is: ~/.cache/puppeteer)
 *
 * — an error that points at a cache directory rather than at the actual
 * fix, and that only appears after the run has already started booting.
 *
 * Resolution order and a boot-time error that names the real remedy are
 * what these tests pin.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, describe } from "node:test";

import { resolveChromeExecutable } from "../../harness/game/puppeteer";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "benchburner-chrome-"));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));

let seq = 0;

/** Creates a file that stands in for an installed browser binary. */
function fakeBrowser(name: string): string {
  const p = path.join(tmpRoot, `${name}-${seq++}`);
  writeFileSync(p, "#!/bin/sh\n");
  return p;
}

describe("resolveChromeExecutable", () => {
  test("prefers an explicitly configured path over everything else", () => {
    const explicit = fakeBrowser("explicit");
    const env = fakeBrowser("env");
    const candidate = fakeBrowser("candidate");

    assert.equal(
      resolveChromeExecutable({
        explicit,
        env,
        candidates: [candidate],
      }),
      explicit,
    );
  });

  test("uses PUPPETEER_EXECUTABLE_PATH when no explicit path is configured", () => {
    const env = fakeBrowser("env");
    const candidate = fakeBrowser("candidate");

    assert.equal(
      resolveChromeExecutable({ env, candidates: [candidate] }),
      env,
    );
  });

  test("discovers a system browser when neither is set — the case that failed", () => {
    const candidate = fakeBrowser("system-chrome");

    assert.equal(
      resolveChromeExecutable({ candidates: [candidate] }),
      candidate,
      "an installed system Chrome should be found without any env var",
    );
  });

  test("skips candidates that do not exist and takes the first that does", () => {
    const real = fakeBrowser("second-choice");

    assert.equal(
      resolveChromeExecutable({
        candidates: [path.join(tmpRoot, "not-installed"), real],
      }),
      real,
    );
  });

  test("fails with an actionable message rather than deferring to Puppeteer's cache error", () => {
    assert.throws(
      () => resolveChromeExecutable({ candidates: [path.join(tmpRoot, "nope")] }),
      (e: Error) => {
        // The remedy, not the symptom: the message must name the env var
        // the operator can set and mention installing a browser.
        assert.match(e.message, /PUPPETEER_EXECUTABLE_PATH/);
        assert.match(e.message, /Chrome/i);
        assert.doesNotMatch(
          e.message,
          /cache path/i,
          "should not repeat Puppeteer's misleading cache-path framing",
        );
        return true;
      },
    );
  });

  test("a configured path that does not exist is an error, not a silent fallback", () => {
    const candidate = fakeBrowser("system-chrome");
    assert.throws(
      () =>
        resolveChromeExecutable({
          explicit: path.join(tmpRoot, "typo-in-config"),
          candidates: [candidate],
        }),
      /typo-in-config/,
      "silently falling back would hide a misconfiguration and change which browser ran",
    );
  });
});
