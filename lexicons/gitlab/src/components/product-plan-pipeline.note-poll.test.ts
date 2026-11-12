/**
 * #5038: GitLab's note poll keeps a product's job name, stage and schedule,
 * as terragucci's `comments` job in its `comments` stage, which a pipeline
 * schedule with `TERRAGUCCI_SCHEDULE=comments` starts. The `note-poll-default`
 * golden was written from main before the change: without the option the
 * pipeline renders as before.
 */
import { describe, expect, test } from "vitest";
import { productPipelineJobs } from "@intentius/chant/components/product-pipeline";
import { generateGitlabProductPlanPipeline } from "./product-plan-pipeline";

const words = {
  product: "terragucci",
  noun: ["root", "roots"] as [string, string],
  commands: { plan: "plan" as const, apply: "apply" as const },
  op: "tf-apply",
  gateName: "wave-{k}",
  approval: "per-wave" as const,
  bin: "terragucci chant",
};

const base = {
  words,
  noteCommands: true,
  waves: { name: "tf-apply", op: "tf-apply", step: { kind: "terraform-apply", root: "{target}" }, waves: [{ name: "wave-1", runs: [{ target: "network" }] }] },
  wavesSpecFile: ".chant/op-waves/tf-apply.spec.json",
  wavesBeforeMerge: { merge: "auto" as const, mergeTokenSecret: "MERGE_TOKEN" },
  productPlan: { command: "terragucci plan --pr-note {output}", replan: { notAffected: true } },
};

type Job = { stage?: string; resource_group?: string; rules?: Array<{ if: string }> };
const terragucci = { jobName: "comments", stage: "comments", schedule: { variable: "TERRAGUCCI_SCHEDULE", value: "comments" } };
const RULE = '$CI_PIPELINE_SOURCE =~ /^(schedule|web|api|trigger)$/ && $TERRAGUCCI_SCHEDULE == "comments" && $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH';

describe("the note poll's names on GitLab (#5038)", () => {
  test("without them the pipeline renders as before", async () => {
    await expect(generateGitlabProductPlanPipeline("default", base as never).yaml).toMatchFileSnapshot("./__golden__/note-poll-default.gitlab.yml");
  });

  test("terragucci's: the comments job in its stage, started by TERRAGUCCI_SCHEDULE=comments, in the workflow's rules too", () => {
    const { entries } = generateGitlabProductPlanPipeline("default", { ...base, noteCommandsJob: terragucci } as never);
    const doc = Object.fromEntries(entries) as Record<string, unknown>;
    expect(doc["note-commands"]).toBeUndefined();
    const job = doc.comments as Job;
    expect(job).toMatchObject({ stage: "comments", resource_group: "comments", rules: [{ if: RULE }] });
    expect(doc.stages as string[]).toContain("comments");
    expect(doc.stages as string[]).not.toContain("note-commands");
    expect((doc.workflow as { rules: Array<{ if: string }> }).rules.map((r) => r.if)).toContain(RULE);
    expect(JSON.stringify(entries)).not.toContain("CHANT_NOTE_COMMANDS");
  });

  test("the job name alone: its stage follows it, and the schedule stays chant's", () => {
    const doc = Object.fromEntries(generateGitlabProductPlanPipeline("default", { ...base, noteCommandsJob: { jobName: "comments" } } as never).entries) as Record<string, Job>;
    expect(doc.comments!.stage).toBe("comments");
    expect(doc.comments!.rules![0]!.if).toContain('$CHANT_NOTE_COMMANDS == "1"');
  });

  test("refused: a name GitLab cannot take, another job's name, a bad schedule, no note poll, another forge", () => {
    expect(() => generateGitlabProductPlanPipeline("default", { ...base, noteCommandsJob: { jobName: "stages" } } as never)).toThrow(/not a GitLab job name/);
    expect(() => generateGitlabProductPlanPipeline("default", { ...base, noteCommandsJob: { jobName: "plan" } } as never)).toThrow(/another job's name/);
    expect(() => generateGitlabProductPlanPipeline("default", { ...base, noteCommandsJob: { schedule: { variable: "A B", value: "x" } } } as never)).toThrow(/noteCommandsJob.schedule/);
    expect(() => generateGitlabProductPlanPipeline("default", { ...base, noteCommands: false, wavesBeforeMerge: undefined, noteCommandsJob: terragucci } as never)).toThrow(/set noteCommands/);
    expect(() => productPipelineJobs("github", "default", { words, waves: base.waves, wavesSpecFile: base.wavesSpecFile, commentJob: true, productPlan: base.productPlan, noteCommandsJob: terragucci } as never)).toThrow(/names GitLab's note poll/);
  });
});
