/**
 * A workspace member's pipelines on GitLab (#2542, #2524 D19). GitLab reads
 * one .gitlab-ci.yml, which includes each member's file, so job names carry
 * the member's name and each job carries its own `rules: changes:`.
 */

import { describe, test, expect } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import type { PipelineMember } from "@intentius/chant/lexicon";
import { generateGitlabPipeline } from "./generate-pipeline";
import { generateGitlabOpPipeline } from "./generate-op-pipeline";

const components: DriverComponent[] = [
  { name: "shared-alb", dependsOn: [], deploy: [] },
  {
    name: "api",
    dependsOn: ["shared-alb"],
    deploy: [
      { phase: "Build", steps: [{ kind: "docker-build", context: ".", into: "dist/api.tar" }] },
      { phase: "Publish", steps: [{ kind: "publish-image", from: "archive:dist/api.tar" }] },
    ],
  },
];

const api: PipelineMember = { name: "api", dir: "services/api", file: ".gitlab/ci/chant-api-staging.gitlab-ci.yml" };

type Job = { script: string[]; needs?: string[]; rules?: unknown[]; artifacts?: { paths: string[] }; stage: string };

describe("generateGitlabPipeline for a workspace member", () => {
  test("jobs take the member's name, run in its directory and only on its changes", () => {
    const result = generateGitlabPipeline(components, { env: "staging", member: api });
    const doc = parseYAML(result.yaml) as Record<string, unknown>;
    expect(doc.workflow).toEqual({ name: "chant-components-api-staging" });
    expect(doc["shared-alb"]).toBeUndefined();

    const job = doc["api-api"] as Job;
    expect(job.script).toEqual(["cd services/api", "chant run --components api --env staging --seed-outputs shared-alb.outputs.json"]);
    expect(job.needs).toEqual(["api-shared-alb"]);
    expect(job.rules).toEqual([{ changes: ["services/api/**/*", ".gitlab/ci/chant-api-staging.gitlab-ci.yml"] }]);

    const shared = doc["api-shared-alb"] as Job;
    expect(shared.artifacts).toEqual({ paths: ["services/api/shared-alb.outputs.json"] });

    expect(result.jobs.map((j) => [j.jobName, j.needs])).toEqual([
      ["api-shared-alb", []],
      ["api-api", ["api-shared-alb"]],
    ]);
  });

  test("the promote job is renamed and needs the renamed jobs; archive paths move under the member", () => {
    const doc = parseYAML(generateGitlabPipeline(components, { env: "staging", promoteTo: "prod", member: api }).yaml) as Record<string, unknown>;
    const promote = doc["api-promote-prod"] as Job;
    expect(promote.needs).toEqual(["api-api", "api-shared-alb"]);
    expect(promote.script[0]).toBe("cd services/api");
    expect((doc["api-api"] as Job).artifacts?.paths).toEqual(["services/api/dist/api.tar", "services/api/api.digest"]);
    // The promote job reads the digest file after its cd, from where the api job wrote it (#2602).
    expect(promote.script[1]).toContain('--digest "api=$(cut -d= -f2- api.digest)"');
    expect(doc.stages).toEqual(["wave-1", "wave-2", "promote"]);
  });

  test("a member at the root has no changes rule, since GitLab's changes can't exclude the other members", () => {
    const doc = parseYAML(generateGitlabPipeline(components, { env: "prod", member: { name: "platform", dir: ".", exclude: ["services/api"] } }).yaml) as Record<string, unknown>;
    const job = doc["platform-api"] as Job;
    expect(job.rules).toBeUndefined();
    expect(job.script[0]).toMatch(/^chant run/);
  });

  test("a directory with a space is quoted for cd", () => {
    const doc = parseYAML(generateGitlabPipeline(components, { env: "prod", member: { name: "odd", dir: "my apps/odd" } }).yaml) as Record<string, unknown>;
    expect((doc["odd-api"] as Job).script[0]).toBe("cd 'my apps/odd'");
  });
});

describe("generateGitlabOpPipeline for a workspace member", () => {
  const member: PipelineMember = { name: "api", dir: "services/api", fileDir: ".gitlab/ci" };

  test("the file and job names carry the member, push and merge-request rules gain changes, cron does not", () => {
    const result = generateGitlabOpPipeline(
      [
        { name: "nightly", trigger: { kind: "cron", schedule: "0 6 * * *" } },
        { name: "plan", trigger: { kind: "pull_request" } },
        { name: "apply", trigger: { kind: "push" } },
      ],
      { member },
    );
    expect(result.files.map((f) => f.name)).toEqual(["api-ops.gitlab-ci.yml"]);
    const doc = parseYAML(result.files[0].yaml) as Record<string, Omit<Job, "rules"> & { resource_group: string; rules: Array<Record<string, unknown>> }>;
    const changes = ["services/api/**/*", ".gitlab/ci/api-ops.gitlab-ci.yml"];

    expect(doc["api-nightly"].rules.every((r) => !("changes" in r))).toBe(true);
    expect(doc["api-plan"].rules.every((r) => JSON.stringify(r.changes) === JSON.stringify(changes))).toBe(true);
    expect(doc["api-apply"].rules.every((r) => JSON.stringify(r.changes) === JSON.stringify(changes))).toBe(true);
    expect(doc["api-apply"].resource_group).toBe("api-apply");
    expect(doc["api-apply"].script[0]).toBe("cd services/api");
    expect(doc["api-apply"].artifacts?.paths).toEqual(["services/api/chant-gate-api-apply.md"]);
  });
});
