/**
 * `--update-snapshot` against a failing snapshot gate (#1825).
 *
 * Since #1475 the k8s/azure gates run in "always" mode, so a stale baseline
 * fails validate on every run — including the update run whose whole purpose
 * is to replace that baseline. These tests run the real pipeline (no mocks)
 * against a fixture lexicon whose validate script behaves like an "always"
 * gate: it fails while the committed snapshot is stale, unless the run is
 * exempted via CHANT_SNAPSHOT_UPDATE.
 */

import { describe, test, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runSurfaceDiff } from "./lexicon-surface-diff";
import { SNAPSHOT_FILENAME } from "../../codegen/lexicon-regen";
import { parseSnapshot } from "../../codegen/surface-snapshot";

const STALE_SNAPSHOT = JSON.stringify({
  schemaVersion: 1,
  generatedAt: "2026-01-01T00:00:00.000Z",
  entries: { Queue: { kind: "resource", resourceType: "X::Y::Queue", attrs: [], props: [] } },
});

const GENERATE_SCRIPT = `node -e "
const fs = require('fs');
const path = require('path');
const dir = path.join(process.cwd(), 'src', 'generated');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'lexicon-test.json'), JSON.stringify({Widget:{kind:'resource',resourceType:'X::Y::Widget',attrs:{Id:'Id'}}}));
fs.writeFileSync(path.join(dir, 'index.d.ts'), 'export declare class Widget { constructor(props: { Name?: string; }); readonly Id: string; }');
"`;

// Emulates a checkSurfaceSnapshot: "always" gate: fail while the committed
// snapshot does not describe the generated surface, unless the run carries the
// update exemption.
const GATED_VALIDATE_SCRIPT = `node -e "
if (process.env.CHANT_SNAPSHOT_UPDATE === '1') process.exit(0);
const fs = require('fs');
const path = require('path');
const snap = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'surface.snapshot.json'), 'utf-8'));
process.exit(snap.entries && snap.entries.Widget ? 0 : 1);
"`;

function makeLexiconDir(validateScript: string): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-sd-update-"));
  const pkg = {
    name: "@intentius/chant-lexicon-test",
    version: "0.1.0",
    type: "module",
    scripts: {
      generate: GENERATE_SCRIPT,
      validate: validateScript,
    },
  };
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  writeFileSync(join(dir, SNAPSHOT_FILENAME), STALE_SNAPSHOT);
  return dir;
}

const baseOpts = { skipBundle: true, skipBuild: true, skipLint: true };

describe("surface-diff --update-snapshot vs. an \"always\" snapshot gate (#1825)", () => {
  test("without --update-snapshot the stale snapshot still fails validate", async () => {
    const dir = makeLexiconDir(GATED_VALIDATE_SCRIPT);
    try {
      const result = await runSurfaceDiff({ lexiconDir: dir, ...baseOpts });
      expect(result.ok).toBe(false);
      expect(result.failures.some((f) => f.step === "validate")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stale snapshot + healthy codegen: the update succeeds and the snapshot matches after", async () => {
    const dir = makeLexiconDir(GATED_VALIDATE_SCRIPT);
    try {
      const result = await runSurfaceDiff({ lexiconDir: dir, ...baseOpts, updateSnapshot: true });
      expect(result.ok).toBe(true);
      expect(result.failures).toEqual([]);

      // The baseline now describes the generated surface, not the stale one.
      const written = parseSnapshot(readFileSync(join(dir, SNAPSHOT_FILENAME), "utf-8"));
      expect(written.entries.Widget).toBeDefined();
      expect(written.entries.Queue).toBeUndefined();

      // A second run against the fresh baseline is green with no exemption.
      const rerun = await runSurfaceDiff({ lexiconDir: dir, ...baseOpts });
      expect(rerun.ok).toBe(true);
      expect(rerun.changed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stale snapshot + another failing validate check: the update refuses", async () => {
    // A validate that fails even with the exemption stands in for any check
    // other than surface-matches-snapshot. The exemption covers only the
    // staleness check, so a broken generate cannot be baselined.
    const dir = makeLexiconDir("node -e \"process.exit(1)\"");
    try {
      const result = await runSurfaceDiff({ lexiconDir: dir, ...baseOpts, updateSnapshot: true });
      expect(result.ok).toBe(false);
      expect(result.failures.some((f) => f.step === "validate")).toBe(true);
      // The stale baseline is untouched.
      expect(readFileSync(join(dir, SNAPSHOT_FILENAME), "utf-8")).toBe(STALE_SNAPSHOT);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
