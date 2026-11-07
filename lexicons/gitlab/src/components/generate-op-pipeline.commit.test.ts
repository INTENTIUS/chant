/** The commit jobs on GitLab (#4722): a comment job in a pipeline of the default branch, and a check job that is off unless asked for. */
import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { ScheduledOpSpec } from "@intentius/chant/lexicon";
import { generateGitlabOpPipeline } from "./generate-op-pipeline";

type Job = { rules?: Array<{ if?: string }>; needs?: unknown; environment?: unknown; script: string[]; artifacts?: Record<string, unknown> };
const gen = (spec: ScheduledOpSpec) => {
  const out = generateGitlabOpPipeline([spec]);
  return { doc: parseYAML(out.files[0]!.yaml) as Record<string, Job>, yaml: out.files[0]!.yaml };
};

const COMMENT: ScheduledOpSpec = { name: "chant-fmt", commit: { on: "comment", comment: "/chant fmt", command: ["tofu", "fmt"], allowed: ["infra/"] } };
const CHECK: ScheduledOpSpec = { name: "fmt-check", trigger: { kind: "pull_request" }, commit: { on: "check", command: ["tofu", "fmt"], allowed: ["infra/"], gitlabCheck: true } };

describe("commit jobs on GitLab (#4722)", () => {
  test("a comment job runs from a pipeline started with the merge request and the word, and the push job holds CHANT_FORGE_TOKEN", () => {
    const { doc, yaml } = gen(COMMENT);
    const commit = doc["chant-fmt"]!;
    expect(commit.rules![0]!.if).toBe('$CI_PIPELINE_SOURCE =~ /^(web|api|trigger|chat)$/ && $CHANT_COMMIT_PR =~ /^[0-9]+$/ && $CHANT_COMMIT == "fmt" && $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH');
    const unset = commit.script.findIndex((l) => l.startsWith("unset "));
    expect(unset).toBeGreaterThan(-1);
    expect(unset).toBeLessThan(commit.script.findIndex((l) => l.includes("chant commit run")));
    const push = doc["chant-fmt-push"]!;
    expect(push.environment).toEqual({ name: "chant-fmt-push", action: "access" });
    expect(push.script.join("\n")).toContain('export CHANT_GITLAB_TOKEN="$CHANT_FORGE_TOKEN"');
    expect(yaml).toContain("scope it to environment chant-fmt-push");
  });

  test("a check job is refused unless gitlabCheck is set", () => {
    expect(() => gen({ ...CHECK, commit: { ...CHECK.commit!, gitlabCheck: undefined } })).toThrow(/off on GitLab/);
  });

  test("with gitlabCheck, the commit job follows the check and reads its finding", () => {
    const { doc } = gen(CHECK);
    const check = doc["fmt-check"]!;
    expect(check.script.join("\n")).toContain('then echo "CHANT_COMMIT_FINDING=1" > .chant/commit/finding.env');
    expect(check.artifacts).toMatchObject({ reports: { dotenv: ".chant/commit/finding.env" } });
    const commit = doc["fmt-check-commit"]!;
    expect(commit.needs).toEqual([{ job: "fmt-check", artifacts: true }]);
    expect(commit.script[0]).toContain('"${CHANT_COMMIT_FINDING:-0}" != "1"');
    expect(commit.script.join("\n")).toContain("refs/merge-requests/$CI_MERGE_REQUEST_IID/head");
    expect(doc["fmt-check-commit-push"]).toBeDefined();
  });
});
