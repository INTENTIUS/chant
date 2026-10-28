/**
 * #4568: with a control repo, the GitHub and Forgejo pull-request workflows
 * add a `control-dispatch` job after the last apply on merge, which maps the
 * product's secret into CHANT_CONTROL_TOKEN for its one step. The control
 * repo's own workflow runs the member's dependents. Generated YAML only;
 * the request itself is tested against fake forges in
 * packages/core/src/control/control.test.ts.
 */

import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { resolveControlTarget } from "@intentius/chant/control/dispatch";
import { generateGithubPipeline } from "./generate-pipeline";
import { generateControlPipeline } from "./control-pipeline";

const root = (name: string, dependsOn: string[] = []): DriverComponent => ({ name, dependsOn, deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: name }] }] });
const ESTATE: DriverComponent[] = [root("net"), root("app", ["net"])];
const control = { target: resolveControlTarget({ repo: "github.com/acme/control", op: "deploy", tokenSecret: "PLYWOOD_CONTROL_TOKEN" }, "network") };

interface Job {
  needs?: string[];
  if?: string;
  permissions?: Record<string, string>;
  steps: Array<{ name?: string; run?: string; env?: Record<string, string> }>;
}

for (const forge of ["github", "forgejo"] as const) {
  describe(`the ${forge} workflow's control dispatch (#4568)`, () => {
    test("one job after the apply, reading the dispatch token from the product's secret", () => {
      const { yaml } = generateGithubPipeline(ESTATE, { env: "prod", prLoop: { applyOnMerge: true, forge, control, words: { product: "plywood" } } });
      const doc = parseYAML(yaml) as { jobs: Record<string, Job> };
      const job = doc.jobs["control-dispatch"]!;
      expect(job.needs).toEqual(["apply"]);
      expect(job.permissions).toEqual({ contents: "read" });
      expect(job.steps[0]!.env!.CHANT_CONTROL_TOKEN).toBe("${{ secrets.PLYWOOD_CONTROL_TOKEN }}");
      expect(job.steps[0]!.run).toContain(forge === "github" ? "plywood-applied" : "/dispatches");
      // No other job holds the dispatch token.
      for (const [name, other] of Object.entries(doc.jobs)) if (name !== "control-dispatch") expect(JSON.stringify(other)).not.toContain("PLYWOOD_CONTROL_TOKEN");
    });

    test("with a gate per wave, the job follows the last wave and reads the commit it applied", () => {
      const { yaml } = generateGithubPipeline(ESTATE, { env: "prod", prLoop: { applyOnMerge: true, forge, control }, gatedWaves: { gate: "release" } });
      const doc = parseYAML(yaml) as { jobs: Record<string, Job> };
      const job = doc.jobs["control-dispatch"]!;
      expect(job.needs).toEqual(["apply-wave-2"]);
      expect(job.steps[0]!.env!.CHANT_CONTROL_SHA).toBe("${{ needs.apply-wave-2.outputs.green-sha }}");
    });

    test("no apply on merge, no dispatch", () => {
      const { yaml } = generateGithubPipeline(ESTATE, { env: "prod", prLoop: { forge, control } });
      expect((parseYAML(yaml) as { jobs: Record<string, Job> }).jobs["control-dispatch"]).toBeUndefined();
    });
  });
}

describe("the control repo's workflow on GitHub (#4568)", () => {
  test("a repository_dispatch of the product's event and a manual dispatch run the dependents", () => {
    const file = generateControlPipeline({ words: { product: "terragucci" } });
    expect(file.path).toBe(".github/workflows/terragucci-dependents.yml");
    const doc = parseYAML(file.content) as { on: Record<string, any>; jobs: Record<string, Job> };
    expect(doc.on.repository_dispatch.types).toEqual(["terragucci-applied"]);
    // #4617: the outcome an op waves dispatch carries is an input too.
    expect(Object.keys(doc.on.workflow_dispatch.inputs)).toEqual(["member", "op", "sha", "outcome"]);
    expect(doc.jobs.dependents!.steps[1]!.run).toContain("workspace run --dependents-of");
  });
});

// #4619: the note job reads the control repo, read-only, so the note marks the cross-stack edges.
for (const forge of ["github", "forgejo"] as const) {
  describe(`the ${forge} plan-note job's read of the control repo (#4619)`, () => {
    const withRead = { target: resolveControlTarget({ repo: "github.com/acme/control", op: "deploy", tokenSecret: "PLYWOOD_CONTROL_TOKEN", readTokenSecret: "PLYWOOD_CONTROL_READ" }, "network") };

    test("fetches the control repo's chant/lifecycle with the read secret before it posts", () => {
      const { yaml } = generateGithubPipeline(ESTATE, { env: "prod", prLoop: { applyOnMerge: true, forge, control: withRead, words: { product: "plywood" } } });
      const doc = parseYAML(yaml) as { jobs: Record<string, Job> };
      const steps = doc.jobs["plan-note"]!.steps;
      const read = steps.findIndex((s) => s.run?.includes("refs/heads/chant/lifecycle"));
      const post = steps.findIndex((s) => s.run?.includes("components pr-post"));
      expect(read).toBeGreaterThan(-1);
      expect(read).toBe(post - 1);
      expect(steps[read]!.env).toEqual({ CHANT_CONTROL_READ_TOKEN: "${{ secrets.PLYWOOD_CONTROL_READ || github.token }}" });
      expect(steps[read]!.run).toContain('echo "CHANT_CONTROL_DIR=$chant_control_dir" >>"$GITHUB_ENV"');
      // The plan job runs the change's code and never holds the read secret; no job but the dispatch holds the dispatch token.
      expect(JSON.stringify(doc.jobs.plan)).not.toContain("PLYWOOD_CONTROL_READ");
      expect(JSON.stringify(doc.jobs["plan-note"])).not.toContain("PLYWOOD_CONTROL_TOKEN");
    });

    test("without a control repo the note job reads none", () => {
      const { yaml } = generateGithubPipeline(ESTATE, { env: "prod", prLoop: { applyOnMerge: true, forge } });
      expect(yaml).not.toContain("CHANT_CONTROL_DIR");
    });
  });
}
