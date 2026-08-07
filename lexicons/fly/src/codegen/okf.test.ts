import { describe, test, expect } from "vitest";
import { packageLexicon } from "./package";
import { okfConformanceProblems, splitFrontmatter } from "@intentius/chant/okf";
import { parseYAML } from "@intentius/chant/yaml";

/**
 * The lexicon OKF bundle (#1060) over fly — the OpenAPI-derived generation
 * path, where property descriptions come out of the generated declarations'
 * JSDoc rather than the registry.
 */
describe("fly OKF bundle", () => {
  test("packaging emits a conformant bundle with spec-sourced property descriptions", async () => {
    const { spec } = await packageLexicon();
    expect(spec.okf).toBeDefined();
    expect(okfConformanceProblems(spec.okf!)).toEqual([]);

    const files = new Map(spec.okf!.map((f) => [f.path, f.content]));
    const machine = splitFrontmatter(files.get("types/Machine.md")!)!;
    const front = parseYAML(machine.frontmatter);
    expect(front.type).toBe("resource-type");
    expect(front.resource_type).toBe("Fly::Machines::Machine");
    // Description carried over from the Machines OpenAPI spec via the d.ts JSDoc.
    expect(machine.body).toContain("Unique name for this Machine");
  }, 120_000);

  test("rules cross-link with the types they govern, both directions", async () => {
    const { spec } = await packageLexicon();
    const files = new Map(spec.okf!.map((f) => [f.path, f.content]));

    const machine = splitFrontmatter(files.get("types/Machine.md")!)!;
    expect(machine.body).toContain("## Governed by");
    const ruleLink = machine.body.match(/\[([A-Z0-9]+)\]\(\/rules\/([A-Z0-9]+)\.md\)/);
    expect(ruleLink).not.toBeNull();
    const rule = splitFrontmatter(files.get(`rules/${ruleLink![2]}.md`)!)!;
    expect(rule.body).toContain("- [Machine](/types/Machine.md)");
  }, 120_000);
});
