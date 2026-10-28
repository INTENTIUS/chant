/**
 * The preview comment on GitLab (#4620). GitLab starts no pipeline on a
 * note, so both jobs run in a pipeline of the target branch started with
 * CHANT_PREVIEW_PR set to the merge request's iid. The preview job drops the
 * protected tokens and origin's credentials before the merge request's code
 * runs; the note job posts from its own clone.
 */

import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { generateGitlabPipeline } from "./generate-pipeline";

const ESTATE: DriverComponent[] = [
  { name: "net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "net" }] }] },
];

const WORDS = { product: "plywood", stages: { plan: "preview", apply: "up" }, commands: { preview: "plan" as const }, bin: "npx --no-install plywood" };

interface Job { stage: string; rules: Array<{ if: string; when?: string }>; needs?: unknown[]; variables: Record<string, string>; script: string[] }
type Doc = { workflow: { rules: Array<{ if: string }> }; stages: string[] } & Record<string, Job>;

describe("the GitLab pipeline's preview comment", () => {
  const doc = parseYAML(generateGitlabPipeline(ESTATE, { env: "prod", prLoop: { previewComment: true, words: WORDS } }).yaml) as Doc;
  const RULE = '$CI_PIPELINE_SOURCE =~ /^(web|api|trigger)$/ && $CHANT_PREVIEW_PR =~ /^[0-9]+$/ && $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH';
  const preview = doc["comment-preview"]!;
  const note = doc["comment-preview-note"]!;

  test("both jobs run in a target-branch pipeline started with CHANT_PREVIEW_PR", () => {
    expect(preview.rules).toEqual([{ if: RULE }]);
    expect(note.rules).toEqual([{ if: RULE, when: "always" }]);
    expect(doc.workflow.rules.map((r) => r.if)).toContain(RULE);
    expect(doc.stages).toEqual(expect.arrayContaining(["comment-preview", "comment-preview-note"]));
  });

  test("the preview job drops the tokens, then checks out the head and scrubs origin before any of its code runs", () => {
    const script = preview.script;
    const drop = script.findIndex((l) => l.startsWith("unset CHANT_FORGE_TOKEN"));
    const head = script.findIndex((l) => l.includes("refs/merge-requests/$PR_NUMBER/head"));
    const scrub = script.findIndex((l) => l.startsWith("git remote set-url origin"));
    const plan = script.findIndex((l) => l.includes("plywood ci run plan"));
    expect(drop).toBeGreaterThanOrEqual(0);
    expect(script).toContain("unset CHANT_RUNNER_KEY");
    expect(drop).toBeLessThan(head);
    expect(head).toBeLessThan(scrub);
    expect(scrub).toBeLessThan(plan);
    expect(preview.variables.PR_NUMBER).toBe("$CHANT_PREVIEW_PR");
    expect(preview.variables.BASE_SHA).toBe("$CI_COMMIT_SHA");
  });

  test("the note job finds the head again and posts for that merge request", () => {
    expect(note.variables).toEqual({ PR_NUMBER: "$CHANT_PREVIEW_PR" });
    expect(note.script.some((l) => l.includes("git ls-remote origin"))).toBe(true);
    expect(note.script.at(-1)).toBe('npx --no-install plywood components pr-post --pr "$PR_NUMBER" --head "$HEAD_SHA" --env prod --output .chant/pr --forge gitlab');
  });

  test("no preview job without previewComment", () => {
    const plain = parseYAML(generateGitlabPipeline(ESTATE, { env: "prod", prLoop: { words: WORDS } }).yaml) as Doc;
    expect(plain["comment-preview"]).toBeUndefined();
  });
});
