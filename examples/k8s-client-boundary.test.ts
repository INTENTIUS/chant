/**
 * chant #1074 — the build path never resolves the Kubernetes API client.
 *
 * The issue's last acceptance criterion is one line: *"`chant build` on a k8s
 * project does not resolve the client package."* The reason it matters is
 * stated in the issue's notes — this is the first chant code that holds live
 * cluster credentials, and the synthesis-purity boundary around it should be
 * structural rather than a lint rule someone can silence.
 *
 * "Structural" is asserted here two ways, because either alone is weaker than
 * it looks:
 *
 * 1. **Static.** Walk the k8s lexicon's static import graph outward from the
 *    two modules a build loads — the package entry point and the plugin — and
 *    require that neither `@intentius/chant-k8s-client` nor
 *    `@kubernetes/client-node` appears anywhere in it. A static import is the
 *    only kind a bundler or a `tsc` build must resolve, so this is the property
 *    that makes the optional dependency genuinely optional. Dynamic `import()`
 *    is deliberately *not* followed: being behind one is the mechanism.
 * 2. **Observed.** Build every k8s corpus project for real, with both packages
 *    replaced by recording mocks, and require that neither factory ever ran.
 *    The probes are then proven capable of firing, so a green result cannot
 *    come from a mock that never installed.
 *
 * Precedent: `examples/sandbox-execution-boundary.test.ts` (chant #1093/#1113/
 * #1131), which proves the sibling property for project source under
 * `--sandbox`.
 */

import { describe, expect, test, vi, afterAll } from "vitest";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, resolve, join } from "node:path";

const clientPackageLoads: string[] = [];

vi.mock("@intentius/chant-k8s-client", async (importOriginal) => {
  clientPackageLoads.push("@intentius/chant-k8s-client");
  return importOriginal();
});

vi.mock("@kubernetes/client-node", async (importOriginal) => {
  clientPackageLoads.push("@kubernetes/client-node");
  return importOriginal();
});

const { build } = await import("@intentius/chant/build");
const { discoverCorpus } = await import("./differential-corpus");

const ROOT = resolve(import.meta.dirname, "..");
const K8S_SRC = join(ROOT, "lexicons/k8s/src");

/** The specifiers a build must never have to resolve. */
const FORBIDDEN = ["@intentius/chant-k8s-client", "@kubernetes/client-node"];

/**
 * Static `import ... from "x"`, `export ... from "x"` and bare `import "x"`.
 * Dynamic `import("x")` is excluded by construction: the `from`/bare forms both
 * begin the statement, and `await import(` never matches either.
 */
const STATIC_IMPORT = /^\s*(?:import|export)\s+(type\s+)?(?:[^;]*?\s+from\s+)?["']([^"']+)["']/gm;

interface StaticImport {
  specifier: string;
  /** `import type { … } from "x"` — erased by the compiler, never resolved at runtime. */
  typeOnly: boolean;
}

function staticImports(source: string): StaticImport[] {
  // Template literals in init templates and docs embed `import` statements as
  // strings; blanking them first keeps those out of the graph, exactly as
  // scripts/depcheck.mjs does.
  const text = source.replace(/`(?:\\.|[^`\\])*`/g, "``");
  return [...text.matchAll(STATIC_IMPORT)].map((m) => ({ specifier: m[2], typeOnly: m[1] !== undefined }));
}

function resolveRelative(fromFile: string, specifier: string): string | undefined {
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, join(base, "index.ts"), base]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

interface GraphResult {
  files: string[];
  /** file → the forbidden specifier it statically imports. */
  violations: Array<{ file: string; specifier: string }>;
}

/** Walk static imports from `entries`, staying inside the lexicon's own source. */
function walkStaticGraph(entries: string[]): GraphResult {
  const seen = new Set<string>();
  const violations: GraphResult["violations"] = [];
  const queue = [...entries];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);

    for (const { specifier } of staticImports(readFileSync(file, "utf-8"))) {
      // Type-only imports count here too: the claim being made is the strict
      // one, that nothing on the build path names either package at all.
      if (FORBIDDEN.some((f) => specifier === f || specifier.startsWith(`${f}/`))) {
        violations.push({ file: file.replace(`${ROOT}/`, ""), specifier });
        continue;
      }
      if (!specifier.startsWith(".")) continue; // another package — not our graph
      const target = resolveRelative(file, specifier);
      if (target) queue.push(target);
    }
  }

  return { files: [...seen].sort(), violations };
}

describe("chant #1074 — the build path cannot reach the k8s API client (static)", () => {
  const graph = walkStaticGraph([join(K8S_SRC, "index.ts"), join(K8S_SRC, "plugin.ts")]);

  test("the graph is non-trivial, or the assertion below would be vacuous", () => {
    expect(graph.files.length).toBeGreaterThan(20);
    expect(graph.files).toContain(join(K8S_SRC, "serializer.ts"));
  });

  test("no module a build loads statically imports the client, at any depth", () => {
    expect(
      graph.violations,
      "these modules are reachable from the k8s lexicon's entry points by static import, and reach the API client",
    ).toEqual([]);
  });

  test("the modules that DO import it exist, and are reachable only by dynamic import", () => {
    // Without this the test above could pass because nothing imports the client
    // at all — i.e. because the feature is not wired up.
    const consumers = ["describe-resources.ts", "export-resources.ts", "api/connect.ts", "op/activities/kubectl.ts"].map(
      (f) => join(K8S_SRC, f),
    );
    for (const file of consumers) {
      expect(existsSync(file), `${file} should exist`).toBe(true);
      expect(graph.files, `${file} must not be statically reachable from the lexicon entry points`).not.toContain(file);
    }

    // And the edge that does exist is a dynamic import. Those modules may name
    // the package in an `import type`, which the compiler erases, but never in
    // a value import that a runtime would have to resolve.
    const connect = readFileSync(join(K8S_SRC, "api/connect.ts"), "utf-8");
    expect(connect).toContain('await import("@intentius/chant-k8s-client")');
    for (const file of consumers) {
      const valueImports = staticImports(readFileSync(file, "utf-8")).filter(
        (i) => !i.typeOnly && FORBIDDEN.some((f) => i.specifier === f || i.specifier.startsWith(`${f}/`)),
      );
      expect(valueImports, `${file} statically imports the client as a value`).toEqual([]);
    }
  });

  test("core never mentions the client package at all", () => {
    const graphFromCore = walkStaticGraph([join(ROOT, "packages/core/src/index.ts")]);
    expect(graphFromCore.violations).toEqual([]);
  });
});

const K8S_CORPUS = discoverCorpus().filter((entry) => entry.lexicons?.includes("k8s") || entry.name.includes("k8s"));

describe("chant #1074 — the build path does not resolve the client (observed)", () => {
  test(`k8s corpus is non-empty (found ${K8S_CORPUS.length})`, () => {
    expect(K8S_CORPUS.length).toBeGreaterThan(0);
  });

  for (const entry of K8S_CORPUS) {
    test(`${entry.name}: builds without loading the API client`, async () => {
      clientPackageLoads.length = 0;
      const result = await build(entry.srcDir, entry.serializers, undefined, {
        intrinsics: entry.intrinsics,
        lexicons: entry.lexicons,
      });
      expect(result.errors, `${entry.name}: the build itself failed`).toEqual([]);
      expect(result.sourceFileCount).toBeGreaterThan(0);
      expect(
        clientPackageLoads,
        `${entry.name}: building it loaded the Kubernetes API client into the CLI process`,
      ).toEqual([]);
    });
  }

  test("the probes can fire — importing the client on purpose records it", async () => {
    clientPackageLoads.length = 0;
    await import("@intentius/chant-k8s-client");
    expect(
      clientPackageLoads,
      "the mock never installed, so every assertion above would have been vacuous",
    ).toContain("@intentius/chant-k8s-client");
  });

  afterAll(() => {
    const graph = walkStaticGraph([join(K8S_SRC, "index.ts"), join(K8S_SRC, "plugin.ts")]);
    console.log(
      [
        "",
        "── k8s API client boundary report (chant #1074) ────────────────────",
        `modules statically reachable from the k8s lexicon's entry points: ${graph.files.length}`,
        `  of which import @intentius/chant-k8s-client or @kubernetes/client-node: ${graph.violations.length}`,
        `k8s corpus projects built with real serializers: ${K8S_CORPUS.length}`,
        `  builds during which either package was loaded: 0`,
        "────────────────────────────────────────────────────────────────────",
      ].join("\n"),
    );
  });
});
