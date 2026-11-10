/**
 * #4987 on GitLab: the product plan's reach line reaches the lock job and
 * the note-commands job as written. GitLab expands `$VAR` in a variable's
 * value when the job starts, so a line that reads `$BASE_SHA` and
 * `$HEAD_SHA` (set by `chant lock --reach` and the note poll for each merge
 * request) would arrive with them empty; `expand: false` keeps it literal.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { PR_LOCK_JOB, PR_NOTE_COMMANDS_JOB } from "@intentius/chant/components/pr-pipeline";
import { parseYAML } from "@intentius/chant/yaml";
import { generateGitlabProductPlanPipeline } from "./product-plan-pipeline";

const words = { product: "terragucci", noun: ["root", "roots"] as [string, string], commands: { plan: "plan" as const, apply: "apply" as const, lock: "lock" as const, unlock: "unlock" as const }, approval: "per-wave" as const, op: "tf-apply", bin: "npx --no-install terragucci" };
const waves: OpWavesSpec = { name: "tf-apply", op: "tf-apply", step: { kind: "terraform-apply", root: "{target}" }, waves: [{ name: "dev", runs: [{ target: "envs/dev" }] }] } as OpWavesSpec;
const line = 'terragucci reached --base "$BASE_SHA" --head "$HEAD_SHA"';
const options = { words, waves, locks: "plan" as const, noteCommands: true, wavesBeforeMerge: {}, productPlan: { command: "terragucci plan --out {output}", workflow: "terragucci-pr", reach: { command: line, gate: "tf-apply" }, replan: true } };

type Job = { variables?: Record<string, unknown> };

describe("the reach line on GitLab (#4987)", () => {
  const { yaml } = generateGitlabProductPlanPipeline("default", options);
  const doc = parseYAML(yaml) as Record<string, Job>;

  test("the lock job gets the line unexpanded", () => {
    expect(doc[PR_LOCK_JOB]!.variables!.CHANT_LOCK_REACH).toEqual({ value: line, expand: false });
  });

  test("the note-commands job gets the line unexpanded, beside its other variables", () => {
    const vars = doc[PR_NOTE_COMMANDS_JOB]!.variables!;
    expect(vars.CHANT_LOCK_REACH).toEqual({ value: line, expand: false });
    expect(typeof vars.CHANT_COMMENT_JOBS).toBe("string");
  });
});
