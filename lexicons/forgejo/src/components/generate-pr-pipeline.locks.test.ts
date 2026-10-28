/** The Forgejo pull-request workflow with `ci.locks: plan` (#4327): the GitHub generator's lock and unlock jobs, in the Forgejo dialect. */

import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { generateForgejoPipeline } from "./generate-pipeline";

const ESTATE: DriverComponent[] = [
  { name: "net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "net" }] }] },
];

interface Step { run?: string }
type Doc = { jobs: Record<string, { if?: string; needs?: string[]; steps: Step[] }> };

describe("the Forgejo workflow with ci.locks: plan", () => {
  const doc = parseYAML(generateForgejoPipeline(ESTATE, { env: "prod", prLoop: { locks: "plan" } }).yaml) as Doc;

  test("writes the lock and unlock jobs for forgejo", () => {
    expect(doc.jobs.lock!.needs).toEqual(["plan"]);
    expect(doc.jobs.lock!.steps.find((s) => s.run?.startsWith("chant lock"))!.run).toContain("--forge forgejo");
    expect(doc.jobs.unlock!.if).toContain("github.event.action == 'closed'");
    expect(doc.jobs.unlock!.steps.some((s) => s.run === 'chant unlock --pr "$PR_NUMBER"')).toBe(true);
  });

  test("with plywood's words the lines run through its bin (plywood#22)", () => {
    const words = { product: "plywood", bin: "npx --no-install plywood" };
    const own = parseYAML(generateForgejoPipeline(ESTATE, { env: "prod", prLoop: { locks: "plan", words } }).yaml) as Doc;
    expect(own.jobs.lock!.steps.some((s) => s.run?.startsWith("npx --no-install plywood lock --from-report ") && s.run.endsWith("--forge forgejo"))).toBe(true);
    expect(own.jobs.unlock!.steps.some((s) => s.run === 'npx --no-install plywood unlock --pr "$PR_NUMBER"')).toBe(true);
  });

  test("without ci.locks neither job is written", () => {
    const plain = parseYAML(generateForgejoPipeline(ESTATE, { env: "prod", prLoop: {} }).yaml) as Doc;
    expect(Object.keys(plain.jobs)).not.toContain("lock");
    expect(Object.keys(plain.jobs)).not.toContain("unlock");
  });
});
