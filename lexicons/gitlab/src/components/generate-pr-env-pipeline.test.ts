/**
 * A merge request's environment in the generated GitLab pipeline (#4298):
 * `env-up` starts the GitLab environment `pr-<iid>` and drops the forge
 * tokens before the merge request's code runs (#4295), `env-post` keeps the
 * record and posts the note from the target branch's commit, `env-down` is
 * the environment's stop job, and `env-sweep` runs from a pipeline schedule,
 * since GitLab starts no pipeline when a merge request closes.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { GITLAB_DROP_FORGE_TOKENS } from "@intentius/chant/ci-handover";
import { generateGitlabPipeline } from "./generate-pipeline";

const ESTATE: DriverComponent[] = [{ name: "app", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "kubectl-apply", manifest: "app.yaml" } as never] }] }];
const SCHEMA = join(import.meta.dirname, "..", "codegen", "vendored", "gitlab-ci-schema.json");

interface Job {
  stage: string;
  needs?: string[];
  rules: Array<{ if: string; when?: string }>;
  variables: Record<string, string>;
  script: string[];
  environment?: Record<string, string>;
  resource_group?: string;
}

describe("the GitLab merge-request pipeline with a merge request environment", () => {
  const result = generateGitlabPipeline(ESTATE, { env: "staging", image: "node:22", beforeScript: ["npm ci"], prLoop: { prEnvironment: true, build: true } });
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
    expect(doc.stages).toEqual(expect.arrayContaining(["env", "env-post"]));
    expect(up.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "merge_request_event"' }]);
    expect(up.environment).toEqual({ name: "pr-$CI_MERGE_REQUEST_IID", on_stop: "env-down" });
    expect(up.variables).toEqual({ BASE_SHA: "$CI_MERGE_REQUEST_DIFF_BASE_SHA", PR_NUMBER: "$CI_MERGE_REQUEST_IID", CHANT_ENV: "pr-$CI_MERGE_REQUEST_IID" });
    expect(up.script.at(-1)).toBe('chant components pr-env up --base "$BASE_SHA" --pr "$PR_NUMBER" --output .chant/pr-env --no-push');
    const down = doc["env-down"]!;
    expect(down.environment).toEqual({ name: "pr-$CI_MERGE_REQUEST_IID", action: "stop" });
    expect(down.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "merge_request_event"', when: "manual" }]);
    expect(down.resource_group).toBe(up.resource_group);
  });

  test("env-sweep runs from a pipeline schedule other than the plan notes' (#4328), which the workflow rules let start", () => {
    expect(doc["env-sweep"]!.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "schedule" && $CHANT_PLAN_NOTES != "1"' }]);
    expect(doc.workflow.rules).toContainEqual({ if: '$CI_PIPELINE_SOURCE == "schedule"' });
    expect(doc["env-sweep"]!.script.at(-1)).toBe("chant components pr-env sweep --forge gitlab --output .chant/pr-env");
  });
});

describe("the GitLab env-up job holds no forge token while the merge request's code runs (#4295)", () => {
  const result = generateGitlabPipeline(ESTATE, { env: "staging", image: "example/ci:1", beforeScript: ["npm ci"], prLoop: { prEnvironment: true, build: true } });
  const doc = parseYAML(result.yaml) as Record<string, Job>;

  test("env-up's script drops the tokens first, and every later line runs without them", () => {
    const up = doc["env-up"]!;
    expect(up.script[0]).toBe(GITLAB_DROP_FORGE_TOKENS);
    const SECRET = "glpat-env-handover-4298";
    const tokens = { GITLAB_TOKEN: SECRET, CHANT_FORGE_TOKEN: SECRET, CHANT_GITLAB_TOKEN: SECRET, CI_JOB_TOKEN: SECRET };
    const lines = up.script.map((line, i) => (i === 0 ? line : `env | grep -c ${SECRET} || true`));
    const out = execFileSync("sh", ["-c", lines.join("\n")], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...tokens }, encoding: "utf-8" });
    expect(out.trim().split("\n").every((n) => n === "0")).toBe(true);
    expect(up.variables).not.toHaveProperty("GITLAB_TOKEN");
    expect(up.script.join("\n")).not.toContain("--forge");
  });

  test("env-post takes env-up's artifact, checks out the target branch's commit, and keeps the record and posts", () => {
    const post = doc["env-post"]!;
    expect(post.stage).toBe("env-post");
    expect(post.needs).toEqual(["env-up"]);
    expect(post.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "merge_request_event"', when: "always" }]);
    expect(post.variables).toEqual({ PR_NUMBER: "$CI_MERGE_REQUEST_IID", HEAD_SHA: "$CI_COMMIT_SHA", BASE_SHA: "$CI_MERGE_REQUEST_DIFF_BASE_SHA" });
    expect(post.script[0]).toBe('git checkout --quiet --detach "$BASE_SHA"');
    expect(post.script.at(-1)).toBe('chant components pr-env post --pr "$PR_NUMBER" --head "$HEAD_SHA" --forge gitlab --output .chant/pr-env');
    expect(post.script.join("\n")).not.toMatch(/chant (build|lint)|pr-env up/);
  });
});

describe("the environment's cloud identity (#4330)", () => {
  const prEnvIdentity = { aws: { role: "arn:aws:iam::000000000000:role/pr-env-apply", region: "us-east-1", audience: "sts.amazonaws.com", endpoint: "http://localhost:4566" } };
  const doc = parseYAML(generateGitlabPipeline(ESTATE, { env: "staging", image: "node:22", prLoop: { prEnvironment: true, prEnvIdentity } }).yaml) as Record<string, Job & { id_tokens?: Record<string, unknown> }>;

  test("env-up trades first, and the same line drops the forge tokens before the merge request's code runs", () => {
    const up = doc["env-up"]!;
    expect(up.id_tokens).toBeDefined();
    expect(up.variables.CHANT_CLOUD_TRADE).toBe(JSON.stringify(prEnvIdentity));
    expect(up.script).not.toContain(GITLAB_DROP_FORGE_TOKENS);
    const unset = up.script.findIndex((l) => l.startsWith("unset ") && l.includes("CHANT_FORGE_TOKEN"));
    expect(unset).toBeGreaterThan(-1);
    expect(unset).toBeLessThan(up.script.findIndex((l) => l.startsWith("chant components pr-env up")));
  });

  test("env-down and env-sweep trade for it too, and env-post does not", () => {
    for (const name of ["env-down", "env-sweep"]) expect(doc[name]!.variables.CHANT_CLOUD_TRADE).toBe(JSON.stringify(prEnvIdentity));
    expect(doc["env-post"]!.variables.CHANT_CLOUD_TRADE).toBeUndefined();
  });
});
