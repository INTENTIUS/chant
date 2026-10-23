/**
 * The merge-request pipeline with an apply before merge (#4301, ws-106).
 * GitLab builds a merge request's own pipeline from its own files, so the
 * apply runs in a pipeline of the target branch a person starts with
 * CHANT_APPLY_PR set, and checks out the merge request's head there.
 */

import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { pullRequestCheckout } from "@intentius/chant/components/pr-pipeline";
import { generateGitlabPipeline } from "./generate-pipeline";

const ESTATE: DriverComponent[] = [
  { name: "net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "net" }] }] },
];

interface Job { rules: Array<{ if: string }>; variables: Record<string, string>; script: string[]; resource_group?: string }

describe("the GitLab pipeline with --apply-before-merge", () => {
  const doc = parseYAML(generateGitlabPipeline(ESTATE, { env: "prod", prLoop: { applyBeforeMerge: true } }).yaml) as { workflow: { rules: Array<{ if: string }> }; record: Job; apply: Job };
  const RULE = '$CI_PIPELINE_SOURCE =~ /^(web|api|trigger)$/ && $CHANT_APPLY_PR =~ /^[0-9]+$/ && $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH';

  test("the apply runs in a target-branch pipeline started with CHANT_APPLY_PR, and a push still records", () => {
    expect(doc.apply.rules).toEqual([{ if: RULE }]);
    expect(doc.workflow.rules.map((r) => r.if)).toContain(RULE);
    expect(doc.record.rules[0]!.if).toContain('$CI_PIPELINE_SOURCE == "push"');
    expect(doc.apply.resource_group).toBe("chant-apply-prod");
  });

  test("it checks out the merge request's head and applies before merge from the pipeline's commit", () => {
    expect(doc.apply.variables).toMatchObject({ BASE_SHA: "$CI_COMMIT_SHA", PR_NUMBER: "$CHANT_APPLY_PR" });
    const at = doc.apply.script.indexOf(pullRequestCheckout("gitlab"));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(doc.apply.script.at(-1)).toBe('chant ci run apply --in-place --base "$BASE_SHA" --pr "$PR_NUMBER" --apply-before-merge --env prod --gate pr-apply --forge gitlab');
  });
});
