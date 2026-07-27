import { describe, expect, test, vi, afterAll } from "vitest";
import { discoverCorpus } from "./differential-corpus";

/**
 * chant #1093 — the security property, asserted over the whole corpus rather
 * than a fixture.
 *
 * `packages/core/src/discovery/sandbox/fold-boundary.test.ts` proves the
 * boundary observationally on hand-written fixtures (a `globalThis` marker
 * that fires under plain `--fold` and never under `--sandbox`). This suite
 * proves it STRUCTURALLY, on real chant source: `importModule`
 * (`../packages/core/src/discovery/import.ts`) is the single place anything in
 * discovery executes a module in the CLI's own process — `discover()`'s run
 * loop calls it, and so does every fold path that has to reach a real
 * constructor / composite factory / intrinsic tag. Wrap it, build every corpus
 * entry with `{ fold: true, sandbox: true }`, and record every path it is
 * asked for.
 *
 * The assertion is then exact and needs no probe: NO path inside the entry's
 * own source directory may appear. Whatever is left (chant-core's own
 * modules, the active lexicon packages) is precisely the allowlist
 * `fold-import.ts`'s `isTrustedExecutableBinding` defines — and every one of
 * those the CLI has already imported into this process itself, via
 * `loadPlugins`, before discovery starts.
 *
 * The mock is a pass-through: `importActual` + a recording wrapper, so the
 * builds below behave exactly as they do in production. It is scoped to this
 * file (vitest isolates module registries per test file), so no other suite
 * sees it.
 */

const importedPaths: string[] = [];

vi.mock("../packages/core/src/discovery/import.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../packages/core/src/discovery/import")>();
  return {
    ...actual,
    importModule: (modulePath: string) => {
      importedPaths.push(modulePath);
      return actual.importModule(modulePath);
    },
  };
});

// Imported AFTER the mock declaration for readability only — `vi.mock` is
// hoisted above every import in the file by vitest's transform.
const { build } = await import("@intentius/chant/build");

const CORPUS = discoverCorpus();

interface ReportRow {
  name: string;
  sourceFileCount: number;
  /** Distinct modules `importModule` was asked for in THIS process during the sandboxed build. */
  parentImportCount: number;
  /** Of those, how many were inside the entry's own source directory. Must be 0. */
  projectImportCount: number;
}

const report: ReportRow[] = [];

describe("under --sandbox, no project module is executed in the CLI process (chant #1093)", () => {
  test(`corpus is non-empty (found ${CORPUS.length} source directories)`, () => {
    expect(CORPUS.length).toBeGreaterThan(0);
  });

  for (const entry of CORPUS) {
    test(`${entry.name}: fold executes nothing from ${entry.name}/src in this process`, async () => {
      importedPaths.length = 0;

      const result = await build(entry.srcDir, entry.serializers, undefined, {
        fold: true,
        sandbox: true,
        intrinsics: entry.intrinsics,
        lexicons: entry.lexicons,
      });

      const seen = [...new Set(importedPaths)];
      const fromProject = seen.filter((p) => p.startsWith(entry.srcDir));

      report.push({
        name: entry.name,
        sourceFileCount: result.foldDecisions.length,
        parentImportCount: seen.length,
        projectImportCount: fromProject.length,
      });

      expect(
        fromProject,
        `${entry.name}: these project modules were imported into the CLI process despite --sandbox`,
      ).toEqual([]);
    });
  }

  afterAll(() => {
    const totalProject = report.reduce((sum, r) => sum + r.projectImportCount, 0);
    const totalParent = report.reduce((sum, r) => sum + r.parentImportCount, 0);
    const totalFiles = report.reduce((sum, r) => sum + r.sourceFileCount, 0);
    console.log(
      [
        "",
        "── Sandbox execution-boundary report (chant #1093) ────────────────",
        `corpus: ${report.length}/${CORPUS.length} source directories built with { fold: true, sandbox: true }`,
        `  project source files across the corpus: ${totalFiles}`,
        `  modules importModule() executed in THIS process: ${totalParent} (chant-core + active lexicon packages)`,
        `  of which project source: ${totalProject}`,
        "────────────────────────────────────────────────────────────────────",
      ].join("\n"),
    );
  });
});
