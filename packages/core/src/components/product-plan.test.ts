/**
 * The product plan (#4799): a product's plan verb in place of `pr-plan`,
 * with a plan job and a note job per target, each holding only its target's
 * values.
 */
import { describe, expect, test } from "vitest";
import { productPipelineJobs } from "./product-pipeline";
import { PR_PLAN_NOTE_WORDS_ENV } from "./product-plan";
import { TERRAGUCCI, TERRAGUCCI_NOTE, YODEL } from "../__fixtures__/product-words";
import type { CiProductCommand } from "../ci-product-words";

const yodel = { ...YODEL, commands: {} as Record<string, CiProductCommand> };
const terragucci = { ...TERRAGUCCI, commands: { plan: "plan" as const }, aliases: [] };

const environments = {
  command: "yodel plan {target} --pr-note {output}",
  targets: [
    { name: "staging", secrets: { PG_READER_URL: "STAGING_PG_READER_URL" }, writeProbe: "yodel config check staging --write-probe" },
    { name: "prod", secrets: { PG_READER_URL: "PROD_PG_READER_URL" }, variables: { YODEL_REQUIRES: "staging" } },
  ],
};

describe("the product plan (#4799)", () => {
  test("without productPlan the jobs carry none, as before", () => {
    expect(productPipelineJobs("github", "default", { words: terragucci })).not.toHaveProperty("productPlan");
  });

  test.each(["github", "forgejo", "gitlab"] as const)("on %s, one plan job and one note job per target, each with only its own target's values", (forge) => {
    const [staging, prod] = productPipelineJobs(forge, "default", { words: yodel, productPlan: environments }).productPlan!;
    const gitlab = forge === "gitlab";
    expect(staging!.jobName).toBe(gitlab ? "staging-plan" : "plan-staging");
    expect(staging!.noteJobName).toBe(gitlab ? "staging-plan-note" : "plan-note-staging");
    expect(staging!.command).toBe("yodel plan staging --pr-note .chant/pr");
    expect(staging!.writeProbe).toBe("yodel config check staging --write-probe");
    expect(prod!.command).toBe("yodel plan prod --pr-note .chant/pr");
    expect(Object.keys(staging!.env).sort()).toEqual(["BASE_SHA", "PG_READER_URL", "PR_NUMBER"]);
    expect(Object.keys(prod!.env).sort()).toEqual(["BASE_SHA", "PG_READER_URL", "PR_NUMBER", "YODEL_REQUIRES"]);
    expect(staging!.env.PG_READER_URL).toBe(gitlab ? "$STAGING_PG_READER_URL" : "${{ secrets.STAGING_PG_READER_URL }}");
    expect(prod!.env.PG_READER_URL).toBe(gitlab ? "$PROD_PG_READER_URL" : "${{ secrets.PROD_PG_READER_URL }}");
    // The note posts for the target, through the product's bin.
    expect(staging!.post.command).toContain("yodel chant components pr-post");
    expect(staging!.post.command).toContain("--member staging");
    if (!gitlab) expect(staging!.post.env.PLAN_RESULT).toBe("${{ needs.plan-staging.result }}");
    expect(staging!.artifact).toBe("chant-pr-plan-staging");
    // No forge token in a plan step.
    for (const p of [staging!, prod!]) expect(Object.keys(p.env).filter((k) => /TOKEN/.test(k))).toEqual([]);
  });

  test("without targets, one plan job named as the pull request loop's, and the note words reach the note job", () => {
    const [plan] = productPipelineJobs("github", "default", { words: terragucci, productPlan: { command: "terragucci plan --pr-note {output}", noteWords: TERRAGUCCI_NOTE, artifact: "terragucci-report" } }).productPlan!;
    expect(plan).toMatchObject({ jobName: "plan", noteJobName: "plan-note", command: "terragucci plan --pr-note .chant/pr", artifact: "terragucci-report" });
    expect(plan!.post.command).not.toContain("--member");
    expect(JSON.parse(plan!.post.env[PR_PLAN_NOTE_WORDS_ENV]!)).toEqual(TERRAGUCCI_NOTE);
  });

  test("the pipeline's passed values reach every target, and a name both give is refused", () => {
    const [staging] = productPipelineJobs("github", "default", { words: yodel, variables: { YODEL_LOG: "info" }, productPlan: environments }).productPlan!;
    expect(staging!.env.YODEL_LOG).toBe("info");
    expect(() => productPipelineJobs("github", "default", { words: yodel, secrets: { PG_READER_URL: "X" }, productPlan: environments })).toThrow(/target staging's PG_READER_URL is the pipeline's too/);
  });

  test.each([
    ["a target name that is not one", { targets: [{ name: "a b" }] }, /not a name/],
    ["a target named twice", { targets: [{ name: "prod" }, { name: "prod" }] }, /names target prod twice/],
    ["no targets", { targets: [] }, /targets are empty/],
    ["a forge token on a target", { targets: [{ name: "prod", variables: { GITHUB_TOKEN: "x" } }] }, /GITHUB_TOKEN is one the jobs set or drop/],
  ])("refuses %s", (_what, plan, error) => {
    expect(() => productPipelineJobs("github", "default", { words: yodel, productPlan: { command: "yodel plan {target}", ...plan } })).toThrow(error);
  });

  test.each([
    ["previewComment", { previewComment: true }],
    ["staleNotes", { staleNotes: true }],
    ["applyBeforeMerge", { applyBeforeMerge: true }],
    ["build", { build: true }],
  ])("refuses %s, which the product plan does not carry", (key, extra) => {
    const words = key === "previewComment" ? { ...yodel, commands: { plan: "plan" as const } } : key === "applyBeforeMerge" ? { ...yodel, commands: { apply: "apply" as const } } : yodel;
    expect(() => productPipelineJobs("github", "default", { words, ...extra, productPlan: { command: "yodel plan {target}" } })).toThrow(new RegExp(`takes no ${key}`));
  });
});

test("PRODUCT_PLAN_FLOOR marks the product plan in the ci-product entry", async () => {
  const { NEXT_RELEASE } = await import("../release-floors");
  const ciProduct = (await import("../ci-product")) as Record<string, unknown>;
  expect(ciProduct.PRODUCT_PLAN_FLOOR).toBe(NEXT_RELEASE);
  expect(typeof ciProduct.planNoteHandoff).toBe("function");
});
