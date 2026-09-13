import { describe, test, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  foldProject,
  foldExecutionCounts,
  resetFoldExecutionCounts,
  type FoldExecutionCounts,
} from "../index";

/**
 * chant#2446 — F-Obs-Counters, reachable from the public entry.
 *
 * Both functions were already exported from `discovery/fold-import`, but the
 * public entry re-exports that module by name rather than wholesale, so a
 * consumer importing `@intentius/chant` could not reach them. The
 * specification's harness reports the three integers per build
 * (INTENTIUS/typescript-as-data#121) and had to hold the fixture out for that
 * reason alone.
 *
 * This is a gate against the export being dropped, not a test of the counting
 * itself, which `fold-import.test.ts` already covers. It imports from `../index`
 * on purpose: importing from the module would still pass with the entry broken,
 * which is exactly the failure it exists to catch.
 */
describe("the fold execution counters are on the public entry (chant#2446)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "chant-counters-"));
    resetFoldExecutionCounts();
  });

  test("both functions are exported and the snapshot has F-Obs-Counters' three integers", () => {
    const counts = foldExecutionCounts();
    expect(Object.keys(counts).sort()).toEqual([
      "factoryInterpretations",
      "factoryInvocations",
      "projectFactoryInvocations",
    ]);
    for (const v of Object.values(counts)) expect(typeof v).toBe("number");
  });

  test("reset zeroes them, which is what makes a per-build figure possible", async () => {
    const file = join(root, "app.ts");
    writeFileSync(file, 'export const n = 1 + 1;\n');
    await foldProject([file], []);

    resetFoldExecutionCounts();

    // The counters are process-wide and monotonic, so "per build" means
    // zeroing first. A caller that could not reset would read this process's
    // whole history and call it one build.
    expect(foldExecutionCounts()).toEqual<FoldExecutionCounts>({
      factoryInvocations: 0,
      projectFactoryInvocations: 0,
      factoryInterpretations: 0,
    });
  });

  test("a snapshot is a copy, so a caller cannot move the counters by holding one", () => {
    const snapshot = foldExecutionCounts() as FoldExecutionCounts;
    snapshot.factoryInvocations = 9999;
    expect(foldExecutionCounts().factoryInvocations).not.toBe(9999);
  });
});
