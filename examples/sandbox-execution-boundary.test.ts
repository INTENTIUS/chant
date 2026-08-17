import { describe, expect, test, vi, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverCorpus, entryBuildParams } from "./differential-corpus";

/**
 * chant #1093, extended by chant #1113 and #1131 — the security property,
 * asserted over the whole corpus rather than a fixture.
 *
 * `packages/core/src/discovery/sandbox/fold-boundary.test.ts`,
 * `.../config-boundary.test.ts` and `.../policy-boundary.test.ts` prove the
 * boundary observationally on hand-written fixtures (a `globalThis` marker that
 * fires without `--sandbox` and never with it). This suite proves it
 * STRUCTURALLY, on real chant source, by wrapping every place project-authored
 * code is executed in the CLI's own process:
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
 * - `importPolicyModule` (`../packages/core/src/lint/policy-import.ts`) — the
 *   project's `lint.policies` modules. This was the residual #1113 documented
 *   and #1131 closed. It also needed a second, differently-shaped section
 *   below: policies are loaded by `buildCommand`, not by `build()`, so the
 *   corpus loop in the first section never reaches them — which is exactly
 *   the gap #1131 names.
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
const inProcessPolicyImports: string[] = [];

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

vi.mock("../packages/core/src/lint/policy-import.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../packages/core/src/lint/policy-import")>();
  return {
    ...actual,
    importPolicyModule: (policyPath: string) => {
      inProcessPolicyImports.push(policyPath);
      return actual.importPolicyModule(policyPath);
    },
  };
});

// Imported AFTER the mock declarations for readability only — `vi.mock` is
// hoisted above every import in the file by vitest's transform.
const { build } = await import("@intentius/chant/build");
const { loadChantConfigUpward } = await import("@intentius/chant/config");
const { buildCommand } = await import("@intentius/chant/cli/commands/build");
const { armSandboxConfigEvaluation, resetSandboxConfigEvaluationForTests } = await import(
  "../packages/core/src/config-sandbox"
);
const { resetSandboxPolicyExecutionForTests } = await import("../packages/core/src/lint/policy-sandbox");
const { foldExecutionCounts, resetFoldExecutionCounts } = await import("../packages/core/src/discovery/fold-import");

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
  /**
   * chant #1023 — composite factory bodies this sandboxed build evaluated
   * STATICALLY rather than calling. Each one is a file that would otherwise
   * have been demoted to the child (chant #1111's measured cost), so this is
   * the coverage half of the same boundary the counts above are the safety
   * half of.
   */
  factoryInterpretations: number;
  /**
   * Factory calls that were still invoked in this process. Every one of them is
   * on the trusted allowlist by construction — a project-owned callee is
   * refused under `--sandbox` — so this is expected to be nonzero and the
   * PROJECT-owned count below is what must be 0.
   */
  factoryInvocations: number;
  projectFactoryInvocations: number;
}

const report: ReportRow[] = [];

/** chant #1131 — one row per corpus entry whose config declares `lint.policies`. */
interface PolicyRow {
  name: string;
  policies: string[];
  /** Policy modules imported into THIS process during the SANDBOXED build. Must be 0. */
  inProcessUnderSandbox: number;
  /** Policy modules imported into this process during the PLAIN build. Must be > 0 — this is what proves the wrapper can fire at all. */
  inProcessPlain: number;
  /** `[policy:…]` lines the plain build produced. Must match the sandboxed build's, and must be > 0 for the comparison to mean anything. */
  diagnosticCount: number;
}

const policyReport: PolicyRow[] = [];

describe("under --sandbox, no project module is executed in the CLI process (chant #1093, #1113)", () => {
  test(`corpus is non-empty (found ${CORPUS.length} source directories)`, () => {
    expect(CORPUS.length).toBeGreaterThan(0);
  });

  for (const entry of CORPUS) {
    test(`${entry.name}: nothing from ${entry.name} — config included — runs in this process`, async () => {
      importedPaths.length = 0;
      inProcessConfigEvaluations.length = 0;
      resetFoldExecutionCounts();

      // What `chant build` does before it builds: read the project's config.
      // Armed, this goes through the sandboxed child; the wrapper above is
      // what would catch it if it did not.
      const loaded = await loadChantConfigUpward(entry.srcDir);

      const result = await build(entry.srcDir, entry.serializers, undefined, {
        fold: true,
        sandbox: true,
        intrinsics: entry.intrinsics,
        lexicons: entry.lexicons,
        buildParams: await entryBuildParams(entry),
      });

      const seen = [...new Set(importedPaths)];
      const fromProject = seen.filter((p) => p.startsWith(entry.srcDir));
      const counts = foldExecutionCounts();

      report.push({
        name: entry.name,
        sourceFileCount: result.foldDecisions.length,
        parentImportCount: seen.length,
        projectImportCount: fromProject.length,
        hasTsConfig: loaded.configPath?.endsWith(".ts") ?? false,
        inProcessConfigCount: inProcessConfigEvaluations.length,
        factoryInterpretations: counts.factoryInterpretations,
        factoryInvocations: counts.factoryInvocations,
        projectFactoryInvocations: counts.projectFactoryInvocations,
      });

      // chant #1023 — the same property the import wrapper above proves, at
      // the one call site that reaches a callee by NAME rather than by module:
      // no project-owned factory may be invoked here under --sandbox.
      expect(
        counts.projectFactoryInvocations,
        `${entry.name}: a project-owned composite factory was invoked in the CLI process despite --sandbox`,
      ).toBe(0);

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

});

/**
 * chant #1131 — the half the section above structurally cannot reach.
 *
 * `lint.policies` is loaded by `buildCommand`, not by `build()`, and only after
 * the build has succeeded. So the corpus loop above — which calls `build()`
 * directly, exactly as every other differential does — never touched a policy
 * module, which is precisely why the hole survived #1113. This section drives
 * the real `buildCommand` instead, for every corpus entry whose config declares
 * policies, and asserts two separate things:
 *
 *  1. **The boundary.** During the `--sandbox` build, `importPolicyModule` is
 *     never called in this process. The probe is proven capable of firing by
 *     the plain build immediately before it, which must call it.
 *  2. **Identical diagnostics.** The `[policy:…]` lines the plain build
 *     produces and the sandboxed build produces must be the same lines, in the
 *     same order. A boundary that changed what a policy *reports* would be a
 *     worse outcome than the hole it closed.
 *
 * `--env prod` is used deliberately: `lexicons/k8s/examples/org-policy`'s
 * `tlsRequiredInProd` check is environment-gated, so `prod` is what makes the
 * comparison non-vacuous (its `ORG-PROD-TLS` violation is a real, failing
 * diagnostic rather than an empty array on both sides). The assertions below
 * require at least one diagnostic, so this stays true if the example changes.
 */
describe("under --sandbox, lint.policies runs in a child, not here (chant #1131)", () => {
  const outDir = mkdtempSync(join(tmpdir(), "chant-1131-gate-"));

  test("buildCommand's policy path: no policy module here, identical diagnostics", async () => {
    for (const entry of CORPUS) {
      const loaded = await loadChantConfigUpward(entry.srcDir);
      const policies = loaded.config.lint?.policies ?? [];
      if (policies.length === 0) continue;

      const options = {
        path: entry.srcDir,
        format: "json" as const,
        serializers: entry.serializers,
        plugins: entry.plugins,
        env: "prod",
        output: join(outDir, `${entry.name.replace(/[/\\]/g, "_")}.json`),
      };

      // Plain half. Disarm both modes so this is a genuine `chant build` —
      // config evaluated here, policies loaded and run here.
      resetSandboxConfigEvaluationForTests();
      resetSandboxPolicyExecutionForTests();
      inProcessPolicyImports.length = 0;
      const plain = await buildCommand(options);
      const plainPolicyImports = [...inProcessPolicyImports];

      // Sandboxed half. Same options plus `--fold --sandbox`, which is what
      // `chant build --fold --sandbox` resolves to.
      armSandboxConfigEvaluation();
      inProcessPolicyImports.length = 0;
      const sandboxed = await buildCommand({ ...options, fold: true, sandbox: true });
      const sandboxedPolicyImports = [...inProcessPolicyImports];

      const policyLines = (r: { errors: string[]; warnings: string[] }): string[] =>
        [...r.errors, ...r.warnings].filter((line) => line.includes("[policy:"));

      expect(
        plainPolicyImports.length,
        `${entry.name}: the plain build must load its policy modules here, or the wrapper below proves nothing`,
      ).toBeGreaterThan(0);
      expect(
        sandboxedPolicyImports,
        `${entry.name}: these policy modules were imported into the CLI process despite --sandbox`,
      ).toEqual([]);
      expect(
        policyLines(plain).length,
        `${entry.name}: no [policy:…] diagnostics on either side — the comparison would be vacuous`,
      ).toBeGreaterThan(0);
      expect(
        policyLines(sandboxed),
        `${entry.name}: --sandbox changed what the policy pack reported`,
      ).toEqual(policyLines(plain));

      policyReport.push({
        name: entry.name,
        policies: [...policies],
        inProcessUnderSandbox: sandboxedPolicyImports.length,
        inProcessPlain: plainPolicyImports.length,
        diagnosticCount: policyLines(plain).length,
      });
    }

    expect(
      policyReport.length,
      "no corpus entry declares lint.policies — this gate would be vacuous",
    ).toBeGreaterThan(0);
  });

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });

    const totalProject = report.reduce((sum, r) => sum + r.projectImportCount, 0);
    const totalParent = report.reduce((sum, r) => sum + r.parentImportCount, 0);
    const totalFiles = report.reduce((sum, r) => sum + r.sourceFileCount, 0);
    const tsConfigs = report.filter((r) => r.hasTsConfig).length;
    const inProcessConfigs = report.reduce((sum, r) => sum + r.inProcessConfigCount, 0);
    const policyModules = policyReport.reduce((sum, r) => sum + r.policies.length, 0);
    const policyInProcess = policyReport.reduce((sum, r) => sum + r.inProcessUnderSandbox, 0);
    const policyDiags = policyReport.reduce((sum, r) => sum + r.diagnosticCount, 0);
    console.log(
      [
        "",
        "── Sandbox execution-boundary report (chant #1093, #1113, #1131) ──",
        `corpus: ${report.length}/${CORPUS.length} source directories built with { fold: true, sandbox: true }`,
        `  project source files across the corpus: ${totalFiles}`,
        `  modules importModule() executed in THIS process: ${totalParent} (chant-core + active lexicon packages)`,
        `  of which project source: ${totalProject}`,
        `  composite factories invoked in THIS process: ${report.reduce((s, r) => s + r.factoryInvocations, 0)} (chant-core + active lexicon packages)`,
        `  of which project-owned: ${report.reduce((s, r) => s + r.projectFactoryInvocations, 0)}`,
        `  composite factory bodies INTERPRETED instead (chant #1023): ${report.reduce((s, r) => s + r.factoryInterpretations, 0)}`,
        `  entries whose build resolved a chant.config.ts: ${tsConfigs}`,
        `  of those, evaluated in THIS process: ${inProcessConfigs}`,
        `  entries declaring lint.policies (built through buildCommand): ${policyReport.length}`,
        `  policy modules across them: ${policyModules}`,
        `  of those, imported in THIS process under --sandbox: ${policyInProcess}`,
        `  [policy:…] diagnostics compared, sandboxed vs plain: ${policyDiags} (identical)`,
        "────────────────────────────────────────────────────────────────────",
      ].join("\n"),
    );
  });
});
