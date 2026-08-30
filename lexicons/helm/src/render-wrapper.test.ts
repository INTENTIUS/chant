import { describe, test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalizeRender } from "./render-digest";
import { persistHelmRender } from "./render-store";
import { routeRender, routeStoredRender, type RoutedRender } from "./render-wrapper";
import { splitDocuments } from "./pinnability/render-stream";

const FIXTURES = join(import.meta.dirname, "..", "test", "survey", "fixtures");

function helmAvailable(): boolean {
  try {
    execFileSync("helm", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hasHelm = helmAvailable();

function renderFixture(chartDir: string): string {
  return execFileSync(
    "helm",
    ["template", "rel", chartDir, "--include-crds", "--kube-version", "1.33.6"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 },
  );
}

/** Every routed document must be byte-identical to a document of the input stream. */
function expectByteIdentity(routed: RoutedRender, input: string): void {
  const inputDocs = splitDocuments(input);
  for (const doc of [...routed.crds, ...routed.hooks, ...routed.main]) {
    expect(inputDocs).toContain(doc.text);
  }
}

function allRoutedTexts(routed: RoutedRender): string[] {
  return [...routed.crds, ...routed.hooks, ...routed.main].map((d) => d.text);
}

// ── pure routing over literal streams ─────────────────────────────────────

const crdDoc = (source: string, name: string, kind: string) =>
  [
    `# Source: umb/${source}`,
    "apiVersion: apiextensions.k8s.io/v1",
    "kind: CustomResourceDefinition",
    "metadata:",
    `  name: ${name}`,
    "spec:",
    "  group: example.com",
    "  names:",
    `    kind: ${kind}`,
  ].join("\n");

describe("routeRender", () => {
  test("routes by crds/ segment, hook annotation, and default main; inherits chart identity", () => {
    const stream = [
      "---",
      crdDoc("crds/parentcrd.yaml", "parentthings.example.com", "ParentThing"),
      "---",
      crdDoc("charts/kid/crds/kidcrd.yaml", "kidthings.example.com", "KidThing"),
      "---",
      "# Source: umb/templates/hook-job.yaml",
      "apiVersion: batch/v1",
      "kind: Job",
      "metadata:",
      "  name: setup",
      "  annotations:",
      '    "helm.sh/hook": pre-install',
      "---",
      "# Source: umb/templates/cm.yaml",
      "apiVersion: v1",
      "kind: ConfigMap",
      "metadata:",
      "  name: cm",
    ].join("\n");
    const routed = routeRender(stream, { chart: "umb", chartVersion: "0.1.0" });

    expect(routed.chart).toBe("umb");
    expect(routed.chartVersion).toBe("0.1.0");
    expect(routed.crds.map((d) => d.source)).toEqual([
      "crds/parentcrd.yaml",
      "charts/kid/crds/kidcrd.yaml", // segment rule: a prefix match would miss this one
    ]);
    expect(routed.hooks.map((d) => d.kind)).toEqual(["Job"]);
    expect(routed.main.map((d) => d.kind)).toEqual(["ConfigMap"]);
    expect(routed.warnings).toEqual([]);
    expectByteIdentity(routed, stream);
  });

  test("deduplicates aliased-dependency CRDs by (group, kind): first wins, warning names both sources", () => {
    const stream = [
      "---",
      crdDoc("charts/kid/crds/kidcrd.yaml", "kidthings.example.com", "KidThing"),
      "---",
      crdDoc("charts/kidtwo/crds/kidcrd.yaml", "kidthings.example.com", "KidThing"),
    ].join("\n");
    const routed = routeRender(stream, { chart: "umb" });

    expect(routed.crds).toHaveLength(1);
    expect(routed.crds[0].source).toBe("charts/kid/crds/kidcrd.yaml");
    expect(routed.warnings).toHaveLength(1);
    expect(routed.warnings[0].code).toBe("duplicate-crd");
    expect(routed.warnings[0].message).toContain("charts/kid/crds/kidcrd.yaml");
    expect(routed.warnings[0].message).toContain("charts/kidtwo/crds/kidcrd.yaml");
    expect(routed.warnings[0].message).toContain("example.com/KidThing");
  });

  test("distinct (group, kind) CRDs are never deduplicated", () => {
    const stream = [
      "---",
      crdDoc("crds/a.yaml", "parentthings.example.com", "ParentThing"),
      "---",
      crdDoc("charts/kid/crds/b.yaml", "kidthings.example.com", "KidThing"),
    ].join("\n");
    const routed = routeRender(stream, { chart: "umb" });
    expect(routed.crds).toHaveLength(2);
    expect(routed.warnings).toEqual([]);
  });

  test("a crds/ document routing cannot identify is kept, never deduplicated", () => {
    // Missing spec.names.kind — no (group, kind) key, so both survive.
    const doc = [
      "# Source: umb/crds/odd.yaml",
      "apiVersion: apiextensions.k8s.io/v1",
      "kind: CustomResourceDefinition",
      "metadata:",
      "  name: oddthings.example.com",
    ].join("\n");
    const routed = routeRender(["---", doc, "---", doc].join("\n"), { chart: "umb" });
    expect(routed.crds).toHaveLength(2);
    expect(routed.warnings).toEqual([]);
  });

  test("template-rendered CRD stays in main per the segment rule, with a note", () => {
    const stream = [
      "---",
      "# Source: umb/templates/crd.yaml",
      "apiVersion: apiextensions.k8s.io/v1",
      "kind: CustomResourceDefinition",
      "metadata:",
      "  name: templated.example.com",
      "spec:",
      "  group: example.com",
      "  names:",
      "    kind: Templated",
    ].join("\n");
    const routed = routeRender(stream, { chart: "umb" });

    expect(routed.crds).toEqual([]);
    expect(routed.main).toHaveLength(1);
    expect(routed.main[0].kind).toBe("CustomResourceDefinition");
    expect(routed.warnings).toHaveLength(1);
    expect(routed.warnings[0].code).toBe("template-crd");
    expect(routed.warnings[0].message).toContain("templated.example.com");
    expect(routed.warnings[0].message).toContain("templates/crd.yaml");
  });

  test("unparseable and source-less documents route to main verbatim", () => {
    const stream = [
      "---",
      "not: [valid: yaml",
      "---",
      "apiVersion: v1",
      "kind: ConfigMap",
      "metadata:",
      "  name: bare",
    ].join("\n");
    const routed = routeRender(stream, { chart: "umb" });
    expect(routed.main).toHaveLength(2);
    expect(routed.main[0]).toMatchObject({ source: null, kind: null, name: null });
    expect(routed.main[1]).toMatchObject({ source: null, kind: "ConfigMap", name: "bare" });
    expectByteIdentity(routed, stream);
  });
});

// ── fixture routing (helm on PATH, offline) ───────────────────────────────

describe.skipIf(!hasHelm)("routeRender over rendered fixtures", () => {
  test("umbrella fixture: groups correct, aliased duplicate deduped with both sources named, bytes identical", () => {
    const canonical = canonicalizeRender(renderFixture(join(FIXTURES, "umbrella-fixture")));
    const routed = routeRender(canonical, { chart: "umbrella-fixture", chartVersion: "0.1.0" });

    // 3 CRD documents rendered (parent + kid + kidtwo), 2 distinct CRDs kept.
    expect(routed.crds.map((d) => d.name).sort()).toEqual([
      "kidthings.example.com",
      "parentthings.example.com",
    ]);
    expect(routed.crds.map((d) => d.source)).toContain("crds/parentcrd.yaml");
    expect(routed.hooks).toEqual([]);
    // Parent cm + kid cm + kidtwo cm (opt is disabled by default).
    expect(routed.main.map((d) => d.kind)).toEqual(["ConfigMap", "ConfigMap", "ConfigMap"]);

    expect(routed.warnings).toHaveLength(1);
    expect(routed.warnings[0].code).toBe("duplicate-crd");
    expect(routed.warnings[0].message).toContain("charts/kid/crds/kidcrd.yaml");
    expect(routed.warnings[0].message).toContain("charts/kidtwo/crds/kidcrd.yaml");

    // Structure preservation: every routed document is byte-identical to a
    // canonical input document, and the groups partition the input minus
    // exactly the one deduplicated duplicate.
    expectByteIdentity(routed, canonical);
    const inputDocs = splitDocuments(canonical);
    expect(allRoutedTexts(routed)).toHaveLength(inputDocs.length - 1);

    // Wrapper inherits the source chart's identity (epic Decisions).
    expect(routed.chart).toBe("umbrella-fixture");
    expect(routed.chartVersion).toBe("0.1.0");
  });

  test("hook fixture: hook-annotated Job routes to its own group, annotations intact", () => {
    const canonical = canonicalizeRender(renderFixture(join(FIXTURES, "hook-fixture")));
    const routed = routeRender(canonical, { chart: "hook-fixture", chartVersion: "0.1.0" });

    expect(routed.hooks).toHaveLength(1);
    expect(routed.hooks[0].kind).toBe("Job");
    expect(routed.hooks[0].text).toContain("helm.sh/hook");
    expect(routed.hooks[0].text).toContain("pre-install");
    expect(routed.hooks[0].text).toContain("helm.sh/hook-delete-policy");
    expect(routed.crds).toEqual([]);
    expect(routed.main.map((d) => d.kind)).toEqual(["ConfigMap"]);
    expect(routed.warnings).toEqual([]);
    expectByteIdentity(routed, canonical);
  });

  test("routeStoredRender routes a stored render by contentDigest, inheriting the manifest's chart identity", () => {
    const root = mkdtempSync(join(tmpdir(), "chant-render-wrapper-"));
    const rendered = renderFixture(join(FIXTURES, "umbrella-fixture"));
    const { manifest } = persistHelmRender({
      rendered,
      releaseName: "rel",
      chart: "umbrella-fixture",
      chartVersion: "0.1.0",
      capabilityProfile: { name: "test", kubeVersion: "1.33.6", apiVersions: [] },
      root,
    });

    const routed = routeStoredRender(manifest.contentDigest, { root });
    expect(routed).toBeDefined();
    expect(routed?.chart).toBe("umbrella-fixture");
    expect(routed?.chartVersion).toBe("0.1.0");
    expect(routed?.crds.map((d) => d.name).sort()).toEqual([
      "kidthings.example.com",
      "parentthings.example.com",
    ]);
    // The routed bytes are the stored bytes: identical to routing the
    // canonical stream directly.
    expect(routed).toEqual(
      routeRender(canonicalizeRender(rendered), { chart: "umbrella-fixture", chartVersion: "0.1.0" }),
    );

    expect(routeStoredRender(`sha256:${"0".repeat(64)}`, { root })).toBeUndefined();
  });
});
