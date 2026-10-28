/**
 * `/<product> <plan word>` (#4620): with `previewComment` a job previews the
 * pull request's head again with a read token, and the job after it posts
 * the note from the target branch's commit, as plan and plan-note do.
 */

import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { generateGithubPipeline } from "./generate-pipeline";

const ESTATE: DriverComponent[] = [
  { name: "net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "net" }] }] },
];

const WORDS = { product: "plywood", stages: { plan: "preview", apply: "up" }, commands: { preview: "plan" as const }, bin: "npx --no-install plywood" };

interface Step { id?: string; name?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> }
interface Job { if?: string; needs?: string[]; permissions: Record<string, string>; outputs?: Record<string, string>; steps: Step[] }
type Doc = { on: Record<string, unknown>; jobs: Record<string, Job> };

const gen = (prLoop: Record<string, unknown>) => parseYAML(generateGithubPipeline(ESTATE, { env: "prod", prLoop }).yaml) as Doc;

describe("the GitHub workflow's preview comment", () => {
  const doc = gen({ previewComment: true, words: WORDS });
  const preview = doc.jobs["comment-preview"]!;
  const note = doc.jobs["comment-preview-note"]!;

  test("started by issue_comment with the plan word, from a commenter who can write", () => {
    expect(doc.on.issue_comment).toEqual({ types: ["created"] });
    expect(preview.if).toContain("github.event_name == 'issue_comment'");
    expect(preview.if).toContain("startsWith(github.event.comment.body, '/plywood preview')");
    expect(preview.if).toContain("github.event.comment.author_association");
  });

  test("the preview job holds a read token only, and drops it before the change's code runs", () => {
    expect(preview.permissions).toEqual({ contents: "read" });
    const checkout = preview.steps[0]!;
    expect(checkout.id).toBe("head");
    expect(checkout.env!.CHANT_PREVIEW_REF).toBe("refs/pull/${{ github.event.issue.number }}/head");
    expect(checkout.run).toContain('echo "head=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"');
    const plan = preview.steps.at(-1)!;
    expect(plan.run).toContain('BASE_SHA="$(git rev-parse --verify "refs/remotes/origin/main^{commit}")"');
    expect(plan.run).toContain("npx --no-install plywood ci run plan");
    expect(plan.env!.PR_NUMBER).toBe("${{ github.event.issue.number }}");
    expect(plan.env!.GITHUB_TOKEN).toBeUndefined();
    expect(preview.outputs!.head).toBe("${{ steps.head.outputs.head }}");
  });

  test("the note job posts from the target branch's commit, for the head the preview job read", () => {
    expect(note.needs).toEqual(["comment-preview"]);
    expect(note.permissions).toEqual({ actions: "read", contents: "read", "pull-requests": "write", statuses: "write" });
    const post = note.steps.at(-1)!;
    expect(post.run).toBe('npx --no-install plywood components pr-post --pr "$PR_NUMBER" --head "$HEAD_SHA" --env prod --output .chant/pr --forge github --result "$PLAN_RESULT"');
    expect(post.env!.HEAD_SHA).toBe("${{ needs.comment-preview.outputs.head }}");
    expect(note.steps.some((s) => s.run?.includes("needs.comment-preview.outputs"))).toBe(true);
  });

  test("no preview job without previewComment", () => {
    const plain = gen({ words: WORDS });
    expect(plain.jobs["comment-preview"]).toBeUndefined();
    expect(plain.on.issue_comment).toBeUndefined();
  });
});
