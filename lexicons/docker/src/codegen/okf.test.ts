import { describe, test, expect } from "vitest";
import { packageLexicon } from "./package";
import { okfConformanceProblems, splitFrontmatter } from "@intentius/chant/okf";
import { parseYAML } from "@intentius/chant/yaml";

/**
 * The lexicon OKF bundle (#1060) over docker — the hand-authored generation
 * path, where descriptions live in the registry itself. Small enough to
 * snapshot whole.
 */
describe("docker OKF bundle", () => {
  test("packaging emits a conformant, snapshot-stable bundle", async () => {
    const { spec } = await packageLexicon();
    expect(spec.okf).toBeDefined();
    expect(okfConformanceProblems(spec.okf!)).toEqual([]);
    expect(spec.okf).toMatchSnapshot();
  });

  test("resource concepts and rules cross-link in both directions", async () => {
    const { spec } = await packageLexicon();
    const files = new Map(spec.okf!.map((f) => [f.path, f.content]));

    const service = splitFrontmatter(files.get("types/Service.md")!)!;
    const front = parseYAML(service.frontmatter);
    expect(front.type).toBe("resource-type");
    expect(front.resource_type).toBe("Docker::Compose::Service");
    // Registry-carried property description reaches the concept body.
    expect(service.body).toContain("- `image` (`string`): Container image to use");
    // The no-latest-tag rule governs Service…
    expect(service.body).toContain("[DKRS001](/rules/DKRS001.md)");
    // …and points back at it.
    const rule = splitFrontmatter(files.get("rules/DKRS001.md")!)!;
    expect(parseYAML(rule.frontmatter).severity).toBe("warning");
    expect(rule.body).toContain("- [Service](/types/Service.md)");
  });
});
