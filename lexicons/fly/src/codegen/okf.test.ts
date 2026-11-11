import { describe, test, expect } from "vitest";
import { packageLexicon } from "./package";
import { okfConformanceProblems, splitFrontmatter } from "@intentius/chant/okf";
import { parseYAML } from "@intentius/chant/yaml";
import { fetchSchemas } from "../spec/fetch";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
    // Descriptions are carried over from the Machines OpenAPI spec via the d.ts
    // JSDoc. The spec is the live, unpinned docs.machines.dev document, and
    // Fly rewords it (the `name` text changed in 2026-11 and broke a
    // hard-coded sentence here), so the expected text is read from the same
    // spec the generator just used rather than written into the test.
    const raw = (await fetchSchemas()).get("Fly::OpenAPI")!;
    const request = JSON.parse(raw.toString("utf-8")).components.schemas.CreateMachineRequest as {
      properties: Record<string, { type?: string; description?: string }>;
    };
    const described = Object.entries(request.properties).filter(([, p]) => p.description?.trim());
    expect(described.map(([key]) => key)).toContain("name");
    for (const [key, prop] of described) {
      const text = prop.description!.replace(/\s+/g, " ").trim();
      expect(machine.body).toMatch(new RegExp(`^- \`${key}\` \\(.*\\): ${escapeRegExp(text)}$`, "m"));
    }
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
