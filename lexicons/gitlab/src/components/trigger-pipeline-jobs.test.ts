/**
 * #5329: the relay starts the alert agent with a pipeline trigger token, and
 * GitLab runs every job of `.gitlab-ci.yml` that a trigger pipeline reaches.
 * The generator names each job of the project's own with no guard, and says
 * so as a fixed notice when it cannot read the file.
 */
import { describe, expect, test } from "vitest";
import { generateGitlabOpPipeline } from "./generate-op-pipeline";
import { TRIGGER_GUARD_RULE, triggerPipelineWarnings } from "./trigger-pipeline-jobs";

const CI = `
stages: [build, deploy]
include:
  - local: ops.gitlab-ci.yml
variables:
  X: "1"
.deploy-base:
  rules:
    - if: '$CI_PIPELINE_SOURCE == "trigger"'
      when: never
    - if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH'
build:
  script: [make]
deploy-prod:
  stage: deploy
  script: [./deploy.sh prod]
  rules:
    - if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH'
deploy-staging:
  extends: .deploy-base
  script: [./deploy.sh staging]
guarded:
  script: [x]
  rules:
    - if: '$CI_PIPELINE_SOURCE != "trigger" && $CI_COMMIT_BRANCH'
legacy:
  script: [x]
  except: [triggers]
`;

describe("the project's own jobs a trigger pipeline starts", () => {
  test("names each job with no rules, or rules with no trigger condition, and shows the rule to add", () => {
    const w = triggerPipelineWarnings({ path: ".gitlab-ci.yml", text: CI }, new Set(), ["ops.gitlab-ci.yml"]);
    expect(w).toHaveLength(2);
    expect(w[0]).toBe(`.gitlab-ci.yml: job build has no rules, so the alert agent's trigger pipeline starts it. Give it rules that begin with:\n${TRIGGER_GUARD_RULE}`);
    expect(w[1]).toContain("job deploy-prod has rules with no condition on a trigger pipeline");
    expect(w[1]).toContain(`- if: '$CI_PIPELINE_SOURCE == "trigger"'\n  when: never`);
    expect(w.join("\n")).not.toMatch(/deploy-staging|guarded|legacy|stages|variables|\.deploy-base/);
  });

  test("an include it cannot see, and a file it cannot read, get the fixed notice", () => {
    const w = triggerPipelineWarnings({ path: ".gitlab-ci.yml", text: "include: 'https://example.com/ci.yml'\n" });
    expect(w).toEqual([expect.stringContaining(".gitlab-ci.yml includes other files, whose jobs were not checked")]);
    expect(triggerPipelineWarnings({ path: ".gitlab-ci.yml" })[0]).toMatch(/^\.gitlab-ci\.yml could not be read, so its jobs were not checked: .*when: never$/s);
    expect(triggerPipelineWarnings(undefined)[0]).toContain("could not be read");
  });

  test("the generator returns the warnings with an alert agent, and the file carries the rule as a notice", () => {
    const out = generateGitlabOpPipeline([{ name: "chant-alert-agent", agent: { on: "alert" } }], { projectCi: { path: ".gitlab-ci.yml", text: CI }, opsFileName: "ops.gitlab-ci.yml" });
    expect(out.warnings?.some((w) => w.includes("job deploy-prod"))).toBe(true);
    expect(out.files[0]!.yaml).toContain(`#   - if: '$CI_PIPELINE_SOURCE == "trigger"'`);
    const unread = generateGitlabOpPipeline([{ name: "chant-alert-agent", agent: { on: "alert" } }]);
    expect(unread.warnings).toEqual([expect.stringContaining("could not be read")]);
    const noAlert = generateGitlabOpPipeline([{ name: "drift-app", trigger: { kind: "cron", schedule: "0 6 * * *" } }], { projectCi: { path: ".gitlab-ci.yml", text: CI } });
    expect(noAlert.warnings).toBeUndefined();
    expect(noAlert.files[0]!.yaml).not.toContain("trigger token");
  });
});
