/**
 * `/<product> lock` and `/<product> unlock` (#4588): under `ci.locks: plan`,
 * when the words name the commands, a job answers each comment at the
 * target branch's commit. The lock job keeps the locks the plan took; the
 * unlock job releases them.
 */

import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { generateGithubPipeline } from "./generate-pipeline";

const ESTATE: DriverComponent[] = [
  { name: "net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "net" }] }] },
];

const WORDS = { product: "plywood", commands: { lock: "lock" as const, unlock: "unlock" as const }, bin: "npx --no-install plywood" };

interface Step { name?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> }
interface Job { if?: string; needs?: string[]; permissions: Record<string, string>; steps: Step[] }
type Doc = { on: Record<string, unknown>; jobs: Record<string, Job> };

const gen = (prLoop: Record<string, unknown>) => parseYAML(generateGithubPipeline(ESTATE, { env: "prod", prLoop }).yaml) as Doc;

describe("the GitHub workflow's lock and unlock comments", () => {
  const doc = gen({ locks: "plan", words: WORDS });

  test("a job per comment, started by issue_comment from a commenter who can write", () => {
    expect(Object.keys(doc.jobs)).toEqual(expect.arrayContaining(["comment-lock", "comment-unlock"]));
    expect(doc.on.issue_comment).toEqual({ types: ["created"] });
    const lock = doc.jobs["comment-lock"]!;
    expect(lock.if).toContain("github.event_name == 'issue_comment'");
    expect(lock.if).toContain("startsWith(github.event.comment.body, '/plywood lock')");
    expect(lock.if).toContain("github.event.comment.author_association");
    expect(doc.jobs["comment-unlock"]!.if).toContain("startsWith(github.event.comment.body, '/plywood unlock')");
  });

  test("the lock keeps the plan's locks through the product's bin, the unlock releases them, at the target branch's commit", () => {
    const lock = doc.jobs["comment-lock"]!;
    expect(lock.steps[0]!.with).toEqual({ "fetch-depth": 0 });
    expect(lock.steps.at(-1)!.run).toBe('npx --no-install plywood lock --keep --pr "$PR_NUMBER" --forge github');
    expect(lock.steps.at(-1)!.env!.PR_NUMBER).toBe("${{ github.event.issue.number }}");
    expect(doc.jobs["comment-unlock"]!.steps.at(-1)!.run).toBe('npx --no-install plywood unlock --pr "$PR_NUMBER"');
    expect(lock.permissions).toEqual({ contents: "write", "pull-requests": "read", statuses: "write" });
  });

  test("neither job without ci.locks, nor without the words for the commands", () => {
    expect(Object.keys(gen({ words: WORDS }).jobs)).not.toContain("comment-lock");
    const chant = gen({ locks: "plan" });
    expect(Object.keys(chant.jobs)).not.toContain("comment-lock");
    expect(chant.on.issue_comment).toBeUndefined();
  });
});
