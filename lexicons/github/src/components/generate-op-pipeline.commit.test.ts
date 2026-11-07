/**
 * The commit jobs (#4722): `ScheduledOpSpec.commit`. The command's job holds a
 * read token and no forge token when the command runs; only the push job writes.
 */

import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { ScheduledOpSpec } from "@intentius/chant/lexicon";
import { generateGithubOpPipeline } from "./generate-op-pipeline";

interface Step {
  id?: string;
  name?: string;
  run?: string;
  env?: Record<string, string>;
}
interface Job {
  needs?: string;
  if?: string;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  outputs?: Record<string, string>;
  steps: Step[];
}
interface Doc {
  on: Record<string, unknown>;
  jobs: Record<string, Job>;
}

const gen = (spec: ScheduledOpSpec) => parseYAML(generateGithubOpPipeline([spec]).files[0]!.yaml) as unknown as Doc;

const COMMENT: ScheduledOpSpec = { name: "chant-fmt", commit: { on: "comment", comment: "/chant fmt", command: ["terraform", "fmt", "-recursive"], allowed: ["infra/"], tokenEnv: "CHANT_PUSH_TOKEN" } };
const CHECK: ScheduledOpSpec = { name: "fmt-check", trigger: { kind: "pull_request" }, commit: { on: "check", command: ["terraform", "fmt", "-recursive"], allowed: ["infra/"], tokenEnv: "CHANT_PUSH_TOKEN", findings: [2, 3] } };

describe("comment commit jobs on GitHub (#4722)", () => {
  test("answer the bare comment from a workflow of their own, with the command's job reading and the push job writing", () => {
    const doc = gen(COMMENT);
    expect(doc.on).toEqual({ issue_comment: { types: ["created"] } });
    const commit = doc.jobs["chant-fmt"]!;
    expect(commit.if).toContain("startsWith(github.event.comment.body, '/chant fmt')");
    expect(commit.permissions).toEqual({ contents: "read", "pull-requests": "read" });
    expect(commit.env).toMatchObject({ CHANT_COMMIT_NAME: "chant-fmt", CHANT_COMMIT_COMMAND: '["terraform","fmt","-recursive"]', CHANT_COMMIT_ALLOWED: '["infra/"]' });
    const run = commit.steps.at(-1)!;
    expect(run.id).toBe("chant-commit");
    expect(run.env).toBeUndefined();
    expect(run.run).toContain("chant commit run --forge github --output .chant/commit");
    expect(commit.steps[0]!.run).toContain("refs/chant/commit-head");
    const push = doc.jobs["chant-fmt-push"]!;
    expect(push.needs).toBe("chant-fmt");
    expect(push.permissions).toMatchObject({ contents: "write", "pull-requests": "write" });
    const land = push.steps.at(-1)!;
    expect(land.env).toMatchObject({ CHANT_COMMIT_TOKEN: "${{ secrets.CHANT_PUSH_TOKEN }}", GITHUB_TOKEN: "${{ secrets.CHANT_PUSH_TOKEN }}" });
    expect(land.run).toContain("chant commit land --forge github");
  });

  test("refuse a spec with no push token", () => {
    expect(() => gen({ ...COMMENT, commit: { ...COMMENT.commit!, tokenEnv: undefined } })).toThrow(/no tokenEnv.*starts no run/);
  });
});

describe("check commit jobs on GitHub (#4722)", () => {
  test("follow the check's job when its run exits with a finding code", () => {
    const doc = gen(CHECK);
    const check = doc.jobs["fmt-check"]!;
    expect(check.outputs).toEqual({ finding: "${{ steps.chant-check.outputs.finding }}" });
    const step = check.steps.find((s) => s.id === "chant-check")!;
    expect(step.run).toContain('if [ "$code" -eq 2 ] || [ "$code" -eq 3 ]; then echo "finding=true" >>"$GITHUB_OUTPUT"; fi');
    expect(step.run).toContain('exit "$code"');
    const commit = doc.jobs["fmt-check-commit"]!;
    expect(commit.needs).toBe("fmt-check");
    expect(commit.if).toBe("always() && needs.fmt-check.outputs.finding == 'true'");
    expect(commit.steps[0]!.env).toMatchObject({ PR_NUMBER: "${{ github.event.pull_request.number }}" });
    expect(doc.jobs["fmt-check-commit-push"]!.needs).toBe("fmt-check-commit");
  });

  test("refuse a check that is not on a pull request", () => {
    expect(() => gen({ ...CHECK, trigger: { kind: "cron", schedule: "0 6 * * *" } })).toThrow(/give it a pull_request trigger/);
  });

  test("leave an Op with no commit as it was", () => {
    const doc = gen({ name: "fmt-check", trigger: { kind: "pull_request" } });
    expect(Object.keys(doc.jobs)).toEqual(["fmt-check"]);
    expect(doc.jobs["fmt-check"]!.outputs).toBeUndefined();
  });
});
