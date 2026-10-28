/**
 * The action job (#4654): with `actionJob`, the pull request loop's
 * workflow answers `/<product> <action word> <member> <action>` and a
 * dispatch with the member and action inputs, at the target branch's
 * commit, through the product's action verb. A dispatch that names an
 * action starts no apply.
 */

import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { generateGithubPipeline } from "./generate-pipeline";

const ESTATE: DriverComponent[] = [
  { name: "shop", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "pulumi-up", stack: "shop/prod-us" }] }] },
];

const WORDS = { product: "plywood", noun: ["stack", "stacks"] as [string, string], commands: { preview: "plan" as const, action: "action" as const }, bin: "npx --no-install plywood" };

interface Step { name?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> }
interface Job { if?: string; needs?: string[]; permissions: Record<string, string>; steps: Step[] }
type Doc = { on: Record<string, unknown>; jobs: Record<string, Job> };

const gen = (prLoop: Record<string, unknown>) => generateGithubPipeline(ESTATE, { env: "prod", prLoop }).yaml;

describe("the GitHub workflow's action job", () => {
  const yaml = gen({ words: WORDS, actionJob: true, applyOnMerge: true });
  const doc = parseYAML(yaml) as Doc;

  test("a dispatch takes the stack and action inputs, and a comment starts the job too", () => {
    expect(doc.on.workflow_dispatch).toEqual({
      inputs: {
        stack: { description: "The stack the action runs on", required: false, type: "string", default: "" },
        action: { description: "The action to run, by its name", required: false, type: "string", default: "" },
      },
    });
    expect(doc.on.issue_comment).toEqual({ types: ["created"] });
    const job = doc.jobs.action!;
    expect(job.if).toContain("github.event_name == 'workflow_dispatch' && github.event.inputs.action != ''");
    expect(job.if).toContain("startsWith(github.event.comment.body, '/plywood action ')");
    expect(job.if).toContain("github.event.comment.author_association");
  });

  test("the job runs the product's verb at the target branch's commit, with the comment and inputs as variables", () => {
    const job = doc.jobs.action!;
    expect(job.steps[0]!.uses).toMatch(/^actions\/checkout@/);
    expect(job.steps[0]!.with).toEqual({ "fetch-depth": 0 });
    const run = job.steps.at(-1)!;
    expect(run.run).toContain("npx --no-install plywood action --from-event");
    expect(run.env).toMatchObject({ CHANT_ACTION_COMMENT: "${{ github.event.comment.body }}", CHANT_ACTION_MEMBER: "${{ github.event.inputs.stack }}", CHANT_ACTION: "${{ github.event.inputs.action }}" });
    expect(job.permissions).toEqual({ contents: "write", issues: "write", "pull-requests": "write" });
  });

  test("a dispatch that names an action starts no apply", () => {
    expect(doc.jobs.apply!.if).toContain("(github.event_name == 'workflow_dispatch' && github.event.inputs.action == '')");
  });

  test("without actionJob nothing changes", () => {
    const plain = parseYAML(gen({ words: { ...WORDS, commands: { preview: "plan" as const } }, applyOnMerge: true })) as Doc;
    expect(plain.jobs.action).toBeUndefined();
    expect(plain.on.workflow_dispatch).toEqual({});
  });

  test("golden", async () => {
    await expect(yaml).toMatchFileSnapshot("./__golden__/pr-loop-action.github.yml");
  });
});
