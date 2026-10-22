/**
 * A merge request's environment in the generated GitLab pipeline (#4298):
 * `env-up` starts the GitLab environment `pr-<iid>`, `env-down` is its stop
 * job, and `env-sweep` runs from a pipeline schedule, since GitLab starts no
 * pipeline when a merge request closes.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { generateGitlabPipeline } from "./generate-pipeline";

const ESTATE: DriverComponent[] = [{ name: "app", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "kubectl-apply", manifest: "app.yaml" } as never] }] }];
const SCHEMA = join(import.meta.dirname, "..", "codegen", "vendored", "gitlab-ci-schema.json");

interface Job {
  stage: string;
  rules: Array<{ if: string; when?: string }>;
  variables: Record<string, string>;
  script: string[];
  environment?: Record<string, string>;
  resource_group?: string;
}

describe("the GitLab merge-request pipeline with a merge request environment", () => {
  const result = generateGitlabPipeline(ESTATE, { env: "staging", image: "node:22", prLoop: { prEnvironment: true } });
  const doc = parseYAML(result.yaml) as { workflow: { rules: Array<{ if: string }> }; stages: string[] } & Record<string, Job>;

  test("validates against the vendored GitLab CI schema", () => {
    const req = createRequire(import.meta.url);
    const mod = req("ajv") as { default?: unknown };
    const Ajv = (mod.default ?? mod) as new (opts: object) => { compile(s: object): ((d: unknown) => boolean) & { errors?: unknown } };
    const validate = new Ajv({ strict: false, allErrors: true }).compile(JSON.parse(readFileSync(SCHEMA, "utf-8")));
    expect(validate(doc), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  test("env-up starts pr-<iid> with env-down as its stop job, one run at a time per merge request", () => {
    const up = doc["env-up"]!;
    expect(doc.stages).toContain("env");
    expect(up.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "merge_request_event"' }]);
    expect(up.environment).toEqual({ name: "pr-$CI_MERGE_REQUEST_IID", on_stop: "env-down" });
    expect(up.variables).toEqual({ BASE_SHA: "$CI_MERGE_REQUEST_DIFF_BASE_SHA", PR_NUMBER: "$CI_MERGE_REQUEST_IID", CHANT_ENV: "pr-$CI_MERGE_REQUEST_IID" });
    expect(up.script.at(-1)).toBe('chant components pr-env up --base "$BASE_SHA" --pr "$PR_NUMBER" --forge gitlab --output .chant/pr-env');
    const down = doc["env-down"]!;
    expect(down.environment).toEqual({ name: "pr-$CI_MERGE_REQUEST_IID", action: "stop" });
    expect(down.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "merge_request_event"', when: "manual" }]);
    expect(down.resource_group).toBe(up.resource_group);
  });

  test("env-sweep runs from a pipeline schedule, which the workflow rules let start", () => {
    expect(doc["env-sweep"]!.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "schedule"' }]);
    expect(doc.workflow.rules).toContainEqual({ if: '$CI_PIPELINE_SOURCE == "schedule"' });
    expect(doc["env-sweep"]!.script.at(-1)).toBe("chant components pr-env sweep --forge gitlab --output .chant/pr-env");
  });
});
