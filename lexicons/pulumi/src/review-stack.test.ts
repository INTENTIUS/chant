/**
 * Review stacks (INTENTIUS/plywood#15): the three fixed argv, on `pr-<n>`
 * names only, under pulumi and plunge. The runners are fakes, so no binary
 * runs and no backend is written.
 */
import { describe, expect, test } from "vitest";
import { initReviewStack, removeReviewStack } from "./review-stack";
import {
  allowedReviewStack,
  isReviewStackName,
  reviewStackDestroyArgs,
  reviewStackInitArgs,
  reviewStackRmArgs,
  runAllowedPlunge,
  runAllowedPulumi,
  runReviewStackPlunge,
  runReviewStackPulumi,
  type PulumiRunner,
} from "./run";

function fake(fail: Record<string, string> = {}) {
  const calls: string[][] = [];
  const run: PulumiRunner = async (args) => {
    calls.push(args);
    const key = args.slice(0, 2).join(" ");
    if (fail[key]) throw Object.assign(new Error("exit 255"), { stderr: fail[key], code: 255 });
    return { stdout: "" };
  };
  return { run, calls };
}

describe("review stack names", () => {
  test("pr-<n>, with an optional suffix and an organization and project in front", () => {
    for (const ok of ["pr-12", "pr-12-shop", "shop/pr-3", "acme/shop/pr-3"]) expect(isReviewStackName(ok), ok).toBe(true);
    for (const no of ["prod", "pr-", "pr-x", "PR-12", "dev-pr-12", "a/b/c/pr-1", "pr-12/x", "-pr-1", ""]) expect(isReviewStackName(no), no).toBe(false);
  });
});

describe("the review stack argv", () => {
  test("the builders give the allowed forms", () => {
    expect(allowedReviewStack(reviewStackInitArgs({ stack: "pr-12", copyConfigFrom: "dev" }))).toBe(true);
    expect(allowedReviewStack(reviewStackInitArgs({ stack: "pr-12" }))).toBe(true);
    expect(allowedReviewStack(reviewStackDestroyArgs({ stack: "pr-12" }))).toBe(true);
    expect(allowedReviewStack(reviewStackRmArgs({ stack: "pr-12" }))).toBe(true);
  });

  test("refuses any other stack, flag or order", async () => {
    const { run, calls } = fake();
    for (const args of [
      ["destroy", "--yes", "--json", "--stack", "prod"],
      ["destroy", "--yes", "--json", "--stack", "pr-12", "--target", "urn:pulumi:x"],
      ["stack", "rm", "--yes", "--force", "--stack", "pr-12"],
      ["stack", "rm", "--yes", "--stack", "dev"],
      ["stack", "init", "prod", "--no-select"],
      ["stack", "init", "pr-1", "--no-select", "--copy-config-from", "pr-1"],
      ["stack", "init", "pr-1"],
      ["up", "--yes", "--json", "--stack", "pr-1"],
    ]) {
      await expect(runReviewStackPulumi(run, args, "/tmp")).rejects.toThrow(/only review stacks/);
      await expect(runReviewStackPlunge(run, args, "/tmp")).rejects.toThrow(/only review stacks/);
    }
    expect(calls).toEqual([]);
  });

  test("the read entry points still refuse all three", async () => {
    const { run } = fake();
    for (const args of [reviewStackInitArgs({ stack: "pr-1" }), reviewStackDestroyArgs({ stack: "pr-1" }), reviewStackRmArgs({ stack: "pr-1" })]) {
      await expect(runAllowedPulumi(run, args, "/tmp")).rejects.toThrow();
      await expect(runAllowedPlunge(run, args, "/tmp")).rejects.toThrow();
    }
  });
});

describe("initReviewStack and removeReviewStack", () => {
  test("creates from the template's config, and an existing stack is found", async () => {
    const a = fake();
    expect(await initReviewStack({ dir: "/w", stack: "pr-7", template: "dev", run: a.run })).toEqual({ stack: "pr-7", status: "created" });
    expect(a.calls).toEqual([["stack", "init", "pr-7", "--no-select", "--copy-config-from", "dev"]]);
    const b = fake({ "stack init": "error: stack 'pr-7' already exists" });
    expect(await initReviewStack({ dir: "/w", stack: "pr-7", template: "dev", run: b.run })).toEqual({ stack: "pr-7", status: "exists" });
  });

  test("destroys, then removes; a stack already gone is absent", async () => {
    const a = fake();
    expect(await removeReviewStack({ dir: "/w", stack: "pr-7", engine: "plunge", run: a.run })).toEqual({ stack: "pr-7", status: "removed" });
    expect(a.calls).toEqual([
      ["destroy", "--yes", "--json", "--stack", "pr-7"],
      ["stack", "rm", "--yes", "--stack", "pr-7"],
    ]);
    const b = fake({ "destroy --yes": "error: no stack named 'pr-7' found" });
    expect(await removeReviewStack({ dir: "/w", stack: "pr-7", run: b.run })).toEqual({ stack: "pr-7", status: "absent" });
    expect(b.calls).toHaveLength(1);
  });

  test("refuses a name that is not a review stack before running anything", async () => {
    const a = fake();
    await expect(removeReviewStack({ dir: "/w", stack: "prod", run: a.run })).rejects.toThrow(/not a review stack/);
    await expect(initReviewStack({ dir: "/w", stack: "staging", template: "dev", run: a.run })).rejects.toThrow(/not a review stack/);
    expect(a.calls).toEqual([]);
  });
});
