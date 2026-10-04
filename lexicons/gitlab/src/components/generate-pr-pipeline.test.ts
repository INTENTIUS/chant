/**
 * The generated merge-request pipeline for GitLab CI (#3183): a plan job in
 * each merge request pipeline, an apply job on each push to the default
 * branch. The whole file has a golden, and it validates against the GitLab
 * CI schema this lexicon vendors.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { generateGitlabPipeline } from "./generate-pipeline";

const ESTATE: DriverComponent[] = [
  { name: "net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "net" }] }] },
  { name: "app", dependsOn: ["net"], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "app" }] }] },
];

const GOLDEN = join(import.meta.dirname, "__fixtures__", "pr-loop.gitlab.golden.yml");
const SCHEMA = join(import.meta.dirname, "..", "codegen", "vendored", "gitlab-ci-schema.json");

interface Job {
  rules: Array<{ if: string }>;
  variables: Record<string, string>;
  script: string[];
  resource_group?: string;
  artifacts: Record<string, unknown>;
}

describe("the GitLab merge-request pipeline", () => {
  const result = generateGitlabPipeline(ESTATE, { env: "prod", prLoop: {} });
  const doc = parseYAML(result.yaml) as { workflow: { rules: unknown[] }; variables: Record<string, string>; plan: Job; apply: Job };

  test("matches its golden", () => {
    if (process.env.UPDATE_GOLDEN) writeFileSync(GOLDEN, result.yaml);
    expect(result.yaml).toBe(readFileSync(GOLDEN, "utf-8"));
  });

  test("validates against the vendored GitLab CI schema", () => {
    const req = createRequire(import.meta.url);
    const mod = req("ajv") as { default?: unknown };
    const Ajv = (mod.default ?? mod) as new (opts: object) => { compile(s: object): ((d: unknown) => boolean) & { errors?: unknown } };
    const validate = new Ajv({ strict: false, allErrors: true }).compile(JSON.parse(readFileSync(SCHEMA, "utf-8")));
    const ok = validate(doc);
    expect(ok, JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  test("plans in a merge request pipeline from its diff base, applies on a push to the default branch, one at a time", () => {
    expect(doc.plan.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "merge_request_event"' }]);
    expect(doc.plan.variables).toEqual({ BASE_SHA: "$CI_MERGE_REQUEST_DIFF_BASE_SHA", PR_NUMBER: "$CI_MERGE_REQUEST_IID" });
    expect(doc.plan.script).toEqual(['chant components pr-plan --base "$BASE_SHA" --pr "$PR_NUMBER" --env prod --gate pr-apply --output .chant/pr --forge gitlab']);
    expect(doc.apply.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH' }]);
    expect(doc.apply.variables).toEqual({ BASE_SHA: "$CI_COMMIT_BEFORE_SHA" });
    expect(doc.apply.script[0]).toContain("--require-review");
    expect(doc.apply.resource_group).toBe("chant-apply-prod");
    expect(doc.variables.GIT_DEPTH).toBe("0");
    expect(doc.apply.artifacts).toEqual({ when: "always", paths: [".chant/pr"] });
  });

  test("a named branch replaces the default branch in the apply rule", () => {
    const yaml = generateGitlabPipeline(ESTATE, { env: "prod", prLoop: { branch: "trunk" } }).yaml;
    expect(yaml).toContain('$CI_COMMIT_BRANCH == "trunk"');
  });

  test("refuses a wave or promote job beside it", () => {
    expect(() => generateGitlabPipeline(ESTATE, { prLoop: {}, gatedWaves: { gate: "g" } })).toThrow(/pull-request pipeline has no wave or promote jobs/);
  });
});
