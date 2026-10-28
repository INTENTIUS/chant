/**
 * Day-2 actions in the product pipeline (#4654): `actions: true` counts the
 * `action` command as answered by the product's own workflow, and
 * `actionJob` writes the job that answers the comment and a dispatch with a
 * member and an action, running the product's action verb, which reads
 * what was asked with `productActionFromEnv`.
 */
import { describe, expect, test } from "vitest";
import { productPipelineJobs } from "./product-pipeline";
import { prActionJob, prLoopJobStage, PR_ACTION_JOB } from "./pr-pipeline";
import { assertProductWords, productActionFromEnv, PRODUCT_ACTION_ENV, PRODUCT_ACTION_EVENT_FLAG } from "../ci-product-words";
import { PLYWOOD, TERRAGUCCI } from "../__fixtures__/product-words";

const PW = { ...PLYWOOD, commands: { preview: "plan" as const, action: "action" as const } };
const TG = { ...TERRAGUCCI, commands: { plan: "plan" as const, action: "action" as const }, aliases: [], bin: "terragucci" };

describe("the action command in the product pipeline (#4654)", () => {
  test("refused without actions, counted with it, and named among the comments", () => {
    expect(() => productPipelineJobs("github", "production", { words: TG })).toThrow(/commands.action needs a action job/);
    const tg = productPipelineJobs("github", "production", { words: TG, actions: true });
    expect(tg.comments.action).toBe("/terragucci action");
    // The product's own workflow answers it: no job here.
    expect(tg.action).toBeUndefined();
  });

  test("actionJob writes the job, answering the comment and a dispatch with the stack and action inputs", () => {
    const pw = productPipelineJobs("github", "production", { words: PW, actionJob: true });
    expect(pw.comments.action).toBe("/plywood action");
    expect(pw.action).toMatchObject({ jobName: PR_ACTION_JOB, comment: "/plywood action", inputs: { member: "stack", action: "action" } });
    expect(pw.action!.command).toBe(`npx --no-install plywood action ${PRODUCT_ACTION_EVENT_FLAG}`);
    expect(pw.action!.env).toMatchObject({
      [PRODUCT_ACTION_ENV.comment]: "${{ github.event.comment.body }}",
      [PRODUCT_ACTION_ENV.member]: "${{ github.event.inputs.stack }}",
      [PRODUCT_ACTION_ENV.action]: "${{ github.event.inputs.action }}",
    });
    // A pending approval is the expected first answer, so chant's waiting exit is a green job.
    expect(pw.action!.script).toContain('if [ "$code" -eq 3 ]; then');
    expect(prLoopJobStage(PR_ACTION_JOB)).toBe("apply");
  });

  test("the inputs can be named, and the job is refused where it cannot run", () => {
    expect(prActionJob("forgejo", { words: TG, actionJob: { inputs: { member: "root", action: "address" } } })!.inputs).toEqual({ member: "root", action: "address" });
    expect(prActionJob("github", { words: PW })).toBeUndefined();
    expect(() => prActionJob("gitlab", { words: PW, actionJob: true })).toThrow(/GitHub and Forgejo/);
    expect(() => prActionJob("github", { words: { ...PW, commands: { preview: "plan" as const } }, actionJob: true })).toThrow(/name no action command/);
    expect(() => prActionJob("github", { words: { ...PW, bin: undefined }, actionJob: true })).toThrow(/no bin/);
    expect(() => prActionJob("github", { words: PW, actionJob: { inputs: { member: "a b" } } })).toThrow(/plain name/);
    expect(() => prActionJob("github", { words: PW, actionJob: { inputs: { member: "action" } } })).toThrow(/two names/);
  });
});

describe("what an action job was asked for (#4654)", () => {
  const words = assertProductWords(PW, { jobs: ["plan", "action"] });

  test("a comment, parsed as a comment is", () => {
    expect(productActionFromEnv(words, { [PRODUCT_ACTION_ENV.comment]: "/plywood action shop/prod-us rotate" })).toEqual({ kind: "action", member: "shop/prod-us", address: "rotate", from: "comment" });
    expect(productActionFromEnv(words, { [PRODUCT_ACTION_ENV.comment]: "/plywood action shop/prod-us" })).toMatchObject({ kind: "refused" });
    expect(productActionFromEnv(words, { [PRODUCT_ACTION_ENV.comment]: "/plywood preview" })).toMatchObject({ kind: "refused", reason: expect.stringContaining("/plywood action <stack> <action>") });
  });

  test("a dispatch's two inputs, checked by the same rules", () => {
    expect(productActionFromEnv(words, { [PRODUCT_ACTION_ENV.member]: "shop/prod-us", [PRODUCT_ACTION_ENV.action]: "rotate", [PRODUCT_ACTION_ENV.comment]: "" })).toEqual({
      kind: "action",
      member: "shop/prod-us",
      address: "rotate",
      from: "dispatch",
    });
    for (const [member, action] of [["", "rotate"], ["shop/prod-us", ""], ["../etc", "rotate"], ["shop/prod-us", "rotate; id"], ["shop/prod-us", "$(id)"], ["shop prod", "rotate"]]) {
      expect(productActionFromEnv(words, { [PRODUCT_ACTION_ENV.member]: member, [PRODUCT_ACTION_ENV.action]: action })).toMatchObject({ kind: "refused" });
    }
  });

  test("words with no action command answer no action", () => {
    expect(productActionFromEnv(assertProductWords(PLYWOOD), { [PRODUCT_ACTION_ENV.member]: "s", [PRODUCT_ACTION_ENV.action]: "a" })).toMatchObject({ kind: "refused", reason: expect.stringMatching(/no action command/) });
  });
});
