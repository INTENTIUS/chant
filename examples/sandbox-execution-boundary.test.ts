import { describe, expect, test, vi, afterAll } from "vitest";
import { discoverCorpus } from "./differential-corpus";

/**
 * chant #1093, extended by chant #1113 — the security property, asserted over
 * the whole corpus rather than a fixture.
 *
 * `packages/core/src/discovery/sandbox/fold-boundary.test.ts` and
 * `.../config-boundary.test.ts` prove the boundary observationally on
 * hand-written fixtures (a `globalThis` marker that fires without `--sandbox`
 * and never with it). This suite proves it STRUCTURALLY, on real chant source,
 * by wrapping the only two places project-authored code is executed in the
 * CLI's own process:
 *
 * - `importModule` (`../packages/core/src/discovery/import.ts`) — discovery.
 *   `discover()`'s run loop calls it, and so does every fold path that has to
 *   reach a real constructor / composite factory / intrinsic tag.
 * - `importConfigModule` / `requireConfigModule`
 *   (`../packages/core/src/config-import.ts`) — the project's own
 *   `chant.config.ts`. This was the residual #1093 documented and #1113
 *   closed: the CLI used to read its configuration by importing that file
 *   in-process, so a hostile repo's config ran with full CLI trust even under
 *   `--sandbox`.
 *
 * For every corpus entry: arm sandboxed config evaluation, load the project
 * config the way `chant build` does (`loadChantConfigUpward`), then build with
 * `{ fold: true, sandbox: true }`, recording every path either wrapper was
 * asked for.
 *
 * The assertion is then exact and needs no probe: NO path inside the entry's
 * own source directory may appear, and the config wrappers must not be called
 * at all. Whatever is left (chant-core's own modules, the active lexicon
 * packages) is precisely the allowlist `fold-import.ts`'s
 * `isTrustedExecutableBinding` defines — and every one of those the CLI has
 * already imported into this process itself, via `loadPlugins`, before
 * discovery starts.
 *
 * The mocks are pass-throughs: `importActual` + a recording wrapper, so the
 * builds below behave exactly as they do in production. They are scoped to
 * this file (vitest isolates module registries per test file), so no other
 * suite sees them.
 */

const importedPaths: string[] = [];
const inProcessConfigEvaluations: string[] = [];

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

vi.mock("../packages/core/src/config-import.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../packages/core/src/config-import")>();
  return {
    ...actual,
    importConfigModule: (configPath: string) => {
      inProcessConfigEvaluations.push(configPath);
      return actual.importConfigModule(configPath);
    },
    requireConfigModule: (configPath: string, dir: string) => {
      inProcessConfigEvaluations.push(configPath);
      return actual.requireConfigModule(configPath, dir);
    },
  };
});

// Imported AFTER the mock declarations for readability only — `vi.mock` is
// hoisted above every import in the file by vitest's transform.
const { build } = await import("@intentius/chant/build");
const { loadChantConfigUpward } = await import("@intentius/chant/config");
const { armSandboxConfigEvaluation } = await import("../packages/core/src/config-sandbox");

// The whole file measures `--sandbox`, so arm once — exactly as `chant build
// --sandbox` does off the parsed flag, before the first config load.
armSandboxConfigEvaluation();

const CORPUS = discoverCorpus();

interface ReportRow {
  name: string;
  sourceFileCount: number;
  /** Distinct modules `importModule` was asked for in THIS process during the sandboxed build. */
  parentImportCount: number;
  /** Of those, how many were inside the entry's own source directory. Must be 0. */
  projectImportCount: number;
  /** Whether this entry has a `chant.config.ts` that had to be evaluated somewhere. */
  hasTsConfig: boolean;
  /** Times the config was evaluated in THIS process. Must be 0. */
  inProcessConfigCount: number;
}

const report: ReportRow[] = [];

describe("under --sandbox, no project module is executed in the CLI process (chant #1093, #1113)", () => {
  test(`corpus is non-empty (found ${CORPUS.length} source directories)`, () => {
    expect(CORPUS.length).toBeGreaterThan(0);
  });

  for (const entry of CORPUS) {
    test(`${entry.name}: nothing from ${entry.name} — config included — runs in this process`, async () => {
      importedPaths.length = 0;
      inProcessConfigEvaluations.length = 0;

      // What `chant build` does before it builds: read the project's config.
      // Armed, this goes through the sandboxed child; the wrapper above is
      // what would catch it if it did not.
      const loaded = await loadChantConfigUpward(entry.srcDir);

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
        hasTsConfig: loaded.configPath?.endsWith(".ts") ?? false,
        inProcessConfigCount: inProcessConfigEvaluations.length,
      });

      expect(
        fromProject,
        `${entry.name}: these project modules were imported into the CLI process despite --sandbox`,
      ).toEqual([]);
      expect(
        inProcessConfigEvaluations,
        `${entry.name}: this project's chant.config.ts was evaluated in the CLI process despite --sandbox`,
      ).toEqual([]);
    });
  }

  afterAll(() => {
    const totalProject = report.reduce((sum, r) => sum + r.projectImportCount, 0);
    const totalParent = report.reduce((sum, r) => sum + r.parentImportCount, 0);
    const totalFiles = report.reduce((sum, r) => sum + r.sourceFileCount, 0);
    const tsConfigs = report.filter((r) => r.hasTsConfig).length;
    const inProcessConfigs = report.reduce((sum, r) => sum + r.inProcessConfigCount, 0);
    console.log(
      [
        "",
        "── Sandbox execution-boundary report (chant #1093, #1113) ─────────",
        `corpus: ${report.length}/${CORPUS.length} source directories built with { fold: true, sandbox: true }`,
        `  project source files across the corpus: ${totalFiles}`,
        `  modules importModule() executed in THIS process: ${totalParent} (chant-core + active lexicon packages)`,
        `  of which project source: ${totalProject}`,
        `  entries whose build resolved a chant.config.ts: ${tsConfigs}`,
        `  of those, evaluated in THIS process: ${inProcessConfigs}`,
        "────────────────────────────────────────────────────────────────────",
      ].join("\n"),
    );
  });
});
