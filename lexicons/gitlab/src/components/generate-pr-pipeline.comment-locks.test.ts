/**
 * `/<product> lock` and `/<product> unlock` on GitLab (#4588). GitLab starts
 * no pipeline on a note, so each job runs in a pipeline of the target
 * branch started with CHANT_LOCK_PR or CHANT_UNLOCK_PR set to the merge
 * request's iid, as the apply before merge does with CHANT_APPLY_PR.
 */

import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { generateGitlabPipeline } from "./generate-pipeline";

const ESTATE: DriverComponent[] = [
  { name: "net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "net" }] }] },
];

const WORDS = { product: "plywood", commands: { lock: "lock" as const, unlock: "unlock" as const }, bin: "npx --no-install plywood" };

interface Job { stage: string; rules: Array<{ if: string }>; variables: Record<string, string>; script: string[] }
type Doc = { workflow: { rules: Array<{ if: string }> }; stages: string[] } & Record<string, Job>;

describe("the GitLab pipeline's lock and unlock comments", () => {
  const doc = parseYAML(generateGitlabPipeline(ESTATE, { env: "prod", prLoop: { locks: "plan", words: WORDS } }).yaml) as Doc;
  const LOCK = '$CI_PIPELINE_SOURCE =~ /^(web|api|trigger)$/ && $CHANT_LOCK_PR =~ /^[0-9]+$/ && $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH';

  test("each job runs in a target-branch pipeline started with its variable", () => {
    expect(doc["comment-lock"]!.rules).toEqual([{ if: LOCK }]);
    expect(doc.workflow.rules.map((r) => r.if)).toContain(LOCK);
    expect(doc["comment-unlock"]!.rules[0]!.if).toContain("$CHANT_UNLOCK_PR");
    expect(doc.stages).toEqual(expect.arrayContaining(["comment-lock", "comment-unlock"]));
  });

  test("the merge request's iid comes from the variable, and the lines run the product's bin", () => {
    expect(doc["comment-lock"]!.variables).toEqual({ PR_NUMBER: "$CHANT_LOCK_PR" });
    expect(doc["comment-lock"]!.script.at(-1)).toBe('npx --no-install plywood lock --keep --pr "$PR_NUMBER" --forge gitlab');
    expect(doc["comment-unlock"]!.script.at(-1)).toBe('npx --no-install plywood unlock --pr "$PR_NUMBER"');
  });

  test("neither job without ci.locks", () => {
    const plain = parseYAML(generateGitlabPipeline(ESTATE, { env: "prod", prLoop: { words: WORDS } }).yaml) as Doc;
    expect(plain["comment-lock"]).toBeUndefined();
  });
});
