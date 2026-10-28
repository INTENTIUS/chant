/**
 * #4619: with a control repo, the Forgejo pull-request workflow's plan-note
 * job fetches the control repo's chant/lifecycle, read-only, and sets
 * CHANT_CONTROL_DIR before it posts, through the Forgejo dialect. Generated
 * YAML only.
 */

import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { resolveControlTarget } from "@intentius/chant/control/dispatch";
import { generateForgejoPipeline } from "./generate-pipeline";

const root = (name: string, dependsOn: string[] = []): DriverComponent => ({ name, dependsOn, deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: name }] }] });
const ESTATE: DriverComponent[] = [root("net"), root("app", ["net"])];
const control = { target: resolveControlTarget({ repo: "forgejo.example.com/acme/control", op: "deploy", readTokenSecret: "PLYWOOD_CONTROL_READ" }, "network") };

describe("the Forgejo plan-note job's read of the control repo (#4619)", () => {
  test("fetches the control repo's chant/lifecycle with the read secret before it posts", () => {
    const { yaml } = generateForgejoPipeline(ESTATE, { env: "prod", prLoop: { applyOnMerge: true, control, words: { product: "plywood" } } });
    const doc = parseYAML(yaml) as { jobs: Record<string, { steps: Array<{ run?: string; env?: Record<string, string> }> }> };
    const steps = doc.jobs["plan-note"]!.steps;
    const read = steps.findIndex((s) => s.run?.includes("refs/heads/chant/lifecycle"));
    expect(read).toBeGreaterThan(-1);
    expect(steps[read + 1]!.run).toContain("components pr-post");
    expect(steps[read]!.env?.CHANT_CONTROL_READ_TOKEN).toBe("${{ secrets.PLYWOOD_CONTROL_READ || github.token }}");
    expect(steps[read]!.run).toContain("'https://forgejo.example.com/acme/control.git'");
    expect(steps[read]!.run).toContain(">>\"$GITHUB_ENV\"");
  });
});
