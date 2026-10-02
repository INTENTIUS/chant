/**
 * Workspace kind conformance (#2535).
 *
 * A package that supplies member kinds publishes them as data at a
 * `./workspace-kinds` subpath (ws-031). This suite holds such a package to
 * the contract core relies on:
 *
 *   1. The subpath is exported by its literal key and names a JSON file
 *      inside the package, so reading kinds never imports the package.
 *   2. The file validates as kind data, supplies at least one kind, uses no
 *      built-in name, and ships in the published package.
 *   3. Every scenario's directory is claimed, or not, as it says, through
 *      core's own probe.
 *   4. No scenario directory that the package's kinds claim is a tie with
 *      the built-in kinds or between the package's own kinds.
 *   5. Every kind has a scenario it claims and one it does not.
 *
 * Point 1 carries the rule that matters most: core reads the file with the
 * file system and never follows a `./*` pattern, so a package that ships
 * its kinds as code fails here before any workspace reads it.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  BUILTIN_KIND_NAMES,
  createKindRegistry,
  kindsExportTarget,
  kindsFileShips,
  probeKind,
  readPackageKinds,
  resolveKind,
} from "../../core/src/workspace/kinds";
import { workingTree } from "../../core/src/workspace/tree";

export interface WorkspaceKindScenario {
  /** Short label, used in the test name. */
  name: string;
  /** The kind the scenario is about. */
  kind: string;
  /** The directory's files, by path relative to it. */
  files: Record<string, string>;
  /** Whether the kind's probe claims the directory. */
  claims: boolean;
}

export interface WorkspaceKindConformanceConfig {
  /** The package directory, holding its package.json. */
  packageDir: string;
  scenarios: WorkspaceKindScenario[];
}

export function describeWorkspaceKindConformance(config: WorkspaceKindConformanceConfig): void {
  const pkg = JSON.parse(readFileSync(join(config.packageDir, "package.json"), "utf-8")) as Record<string, unknown>;
  const label = typeof pkg.name === "string" ? pkg.name : config.packageDir;
  const scratch: string[] = [];
  afterAll(() => {
    for (const d of scratch) rmSync(d, { recursive: true, force: true });
  });
  const materialize = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), "chant-kind-conformance-"));
    scratch.push(dir);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    return dir;
  };

  describe(`workspace kind conformance (#2535): ${label}`, () => {
    it("exports ./workspace-kinds by its literal key, naming a JSON file inside the package", () => {
      const target = kindsExportTarget(pkg);
      expect(target, "package.json has no exports[\"./workspace-kinds\"]").toBeDefined();
      expect(typeof target === "string" ? target : target?.problem).toMatch(/^\.\/.*\.json$/);
    });

    it("publishes valid kind data, with no built-in name, in a file that ships", () => {
      const read = readPackageKinds(config.packageDir);
      expect(read.problems).toEqual([]);
      expect(read.kinds.length).toBeGreaterThan(0);
      for (const k of read.kinds) expect(BUILTIN_KIND_NAMES).not.toContain(k.name);
      expect(read.file).toBeDefined();
      expect(kindsFileShips(config.packageDir, read.file!)).toBe(true);
    });

    it("gives every kind a scenario it claims and one it does not", () => {
      for (const k of readPackageKinds(config.packageDir).kinds) {
        const mine = config.scenarios.filter((s) => s.kind === k.name);
        expect(mine.some((s) => s.claims), `no scenario that ${k.name} claims`).toBe(true);
        expect(mine.some((s) => !s.claims), `no scenario that ${k.name} leaves alone`).toBe(true);
      }
    });

    for (const scenario of config.scenarios) {
      it(`${scenario.kind}: ${scenario.name} (${scenario.claims ? "claimed" : "not claimed"})`, () => {
        const { kinds } = readPackageKinds(config.packageDir);
        const registry = createKindRegistry(kinds);
        const kind = registry.get(scenario.kind);
        expect(kind, `the package supplies no kind ${scenario.kind}`).toBeDefined();
        const tree = workingTree(materialize(scenario.files));
        expect(probeKind(kind!, tree, "")).toBe(scenario.claims);
        if (scenario.claims) {
          const resolution = resolveKind(registry, tree, "");
          expect(resolution.tie.map((k) => k.name), "the probes tie; give one kind a different precedence").toEqual([]);
        }
      });
    }
  });
}
