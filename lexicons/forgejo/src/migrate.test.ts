import { describe, test, expect } from "vitest";
import { transform, detectGitHubWorkflow } from "./migrate/from-github";
import { forgejoPlugin } from "./plugin";

const GHA_WORKFLOW = `name: CI
on:
  push:
    branches:
      - main
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    continue-on-error: true
    steps:
      - uses: actions/checkout@v4
      - uses: some-org/custom-action@v1
      - run: npm test
`;

describe("github → forgejo transform", () => {
  test("emits forgejo YAML with the dialect applied", async () => {
    const { output } = await transform(GHA_WORKFLOW, { sourceFile: "ci.yml" });
    expect(output).toContain("runs-on: docker");
    expect(output).not.toContain("permissions");
    expect(output).not.toContain("continue-on-error");
    expect(output).toContain("https://code.forgejo.org/actions/checkout@v4");
    // unmapped ref still present (passed through), surfaced in the compare
    expect(output).toContain("some-org/custom-action@v1");
  });

  test("classifies property fates (provenance + posture)", async () => {
    const { provenance, securityPosture, diagnostics } = await transform(GHA_WORKFLOW, { sourceFile: "ci.yml" });
    const rules = provenance.map((r) => r.rule);
    expect(rules).toContain("MIG-FJ-PERMISSIONS");
    expect(rules).toContain("MIG-FJ-CONTINUE-ON-ERROR");
    expect(rules).toContain("MIG-FJ-ACTION-UNRESOLVED");
    expect(provenance.find((r) => r.rule === "MIG-FJ-PERMISSIONS")?.security.fate).toBe("lost");
    expect(securityPosture).toContain("## Security posture");
    expect(diagnostics.length).toBe(provenance.length);
  });

  test("emit: ts produces a chant pipeline importing from forgejo", async () => {
    const { output } = await transform(GHA_WORKFLOW, { emit: "ts", sourceFile: "ci.yml" });
    expect(output).toContain("@intentius/chant-lexicon-forgejo");
    expect(output).not.toContain("@intentius/chant-lexicon-github");
  });

  test("detectGitHubWorkflow recognizes a workflow", () => {
    expect(detectGitHubWorkflow(GHA_WORKFLOW)).toBe(true);
    expect(detectGitHubWorkflow("foo: bar\n")).toBe(false);
  });
});

describe("forgejoPlugin.migrationSource", () => {
  test("supports github only", () => {
    expect(forgejoPlugin.migrationSource?.("github")).toBeDefined();
    expect(forgejoPlugin.migrationSource?.("gitlab")).toBeUndefined();
  });

  test("transform mirrors the gitlab MigrationResult shape", async () => {
    const source = forgejoPlugin.migrationSource?.("github");
    expect(source?.detect(GHA_WORKFLOW)).toBe(true);
    const result = await source!.transform(GHA_WORKFLOW, { emit: "yaml", sourceFile: "ci.yml" });
    expect(result.output).toContain("runs-on: docker");
    expect(Array.isArray(result.provenance)).toBe(true);
    expect(Array.isArray(result.diagnostics)).toBe(true);
    expect(result.securityPosture).toContain("Security posture");
  });
});
