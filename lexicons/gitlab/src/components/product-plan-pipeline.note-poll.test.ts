/**
 * #5038: GitLab's note poll keeps a product's job name, stage and schedule,
 * as terragucci's `comments` job in its `comments` stage, which a pipeline
 * schedule with `TERRAGUCCI_SCHEDULE=comments` starts. The `note-poll-default`
 * golden was written from main before the change: without the option the
 * pipeline renders as before.
 */
import { describe, expect, test } from "vitest";
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

describe("the note poll's names on GitLab (#5038)", () => {
  test("without them the pipeline renders as before", async () => {
    await expect(generateGitlabProductPlanPipeline("default", base as never).yaml).toMatchFileSnapshot("./__golden__/note-poll-default.gitlab.yml");
  });
});
