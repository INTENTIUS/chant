/**
 * #4568: with a control repo, the GitLab merge-request pipeline adds a
 * `control-dispatch` job after the last apply on merge, and the plan job
 * unsets the control repo's token variables with the forge tokens, since a
 * CI/CD variable reaches every job. The control repo's own pipeline runs on
 * a trigger. Generated YAML only; the request is tested against fake forges
 * in packages/core/src/control/control.test.ts.
 */

import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { resolveControlTarget } from "@intentius/chant/control/dispatch";
import { generateGitlabPipeline } from "./generate-pipeline";
import { generateControlPipeline } from "./control-pipeline";

const root = (name: string, dependsOn: string[] = []): DriverComponent => ({ name, dependsOn, deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: name }] }] });
const ESTATE: DriverComponent[] = [root("net"), root("app", ["net"])];
const control = { target: resolveControlTarget({ repo: "gitlab.com/acme/control", op: "deploy", tokenSecret: "TERRAGUCCI_CONTROL_TOKEN" }, "network") };

interface Job {
  stage: string;
  needs?: string[];
  rules: Array<{ if: string }>;
  script: string[];
  resource_group?: string;
}

describe("the GitLab pipeline's control dispatch (#4568)", () => {
  test("one job after the apply, and the plan job drops the token variables", () => {
    const { yaml } = generateGitlabPipeline(ESTATE, { env: "prod", prLoop: { applyOnMerge: true, control, words: { product: "terragucci" } } });
    const doc = parseYAML(yaml) as Record<string, Job> & { stages: string[] };
    const job = doc["control-dispatch"]!;
    expect(job.needs).toEqual(["apply"]);
    expect(doc.stages.at(-1)).toBe("control-dispatch");
    expect(job.script[0]).toBe('export CHANT_CONTROL_SHA="$CI_COMMIT_SHA"');
    expect(job.script[1]).toContain('CHANT_CONTROL_TOKEN="${TERRAGUCCI_CONTROL_TOKEN:-}"');
    expect(job.script[1]).toContain("/trigger/pipeline");
    expect(doc.plan!.script.some((l) => l.startsWith("unset ") && l.includes("TERRAGUCCI_CONTROL_TOKEN") && l.includes("CHANT_CONTROL_TOKEN"))).toBe(true);
  });

  test("with a gate per wave, the job follows the last wave and reads its GREEN_SHA", () => {
    const { yaml } = generateGitlabPipeline(ESTATE, { env: "prod", prLoop: { applyOnMerge: true, control }, gatedWaves: { gate: "release" } });
    const doc = parseYAML(yaml) as Record<string, Job>;
    expect(doc["control-dispatch"]!.needs).toEqual(["apply-wave-2"]);
    expect(doc["control-dispatch"]!.script[0]).toBe('export CHANT_CONTROL_SHA="$GREEN_SHA"');
  });
});

describe("the control repo's pipeline on GitLab (#4568)", () => {
  test("a trigger with the member and Op runs the dependents, one member at a time", () => {
    const file = generateControlPipeline({ words: { product: "terragucci" } });
    expect(file.path).toBe(".gitlab/terragucci-dependents.yml");
    const doc = parseYAML(file.content) as Record<string, Job>;
    expect(doc.dependents!.rules[0]!.if).toBe('$CI_PIPELINE_SOURCE == "trigger" && $CHANT_CONTROL_MEMBER && $CHANT_CONTROL_OP');
    expect(doc.dependents!.resource_group).toBe("terragucci-dependents-$CHANT_CONTROL_MEMBER");
    expect(doc.dependents!.script[0]).toContain("workspace run --dependents-of");
  });
});
