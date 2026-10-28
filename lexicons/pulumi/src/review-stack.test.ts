/**
 * Review stacks (INTENTIUS/plywood#15): the three fixed argv, on `pr-<n>`
 * names only, under pulumi and plunge. The runners are fakes, so no binary
 * runs and no backend is written.
 */
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { tearDownPrEnvironment, type LivePrEnvironment } from "@intentius/chant/components/pr-environment";
import {
  initReviewStack,
  parseReviewStackLocation,
  prNumberOf,
  pulumiTemplateStack,
  removeReviewStack,
  reviewConfigSource,
  reviewStackFor,
  reviewStackLocation,
  reviewStackTeardown,
  REVIEW_STACK_TEARDOWN,
} from "./review-stack";
import { pulumiPlugin } from "./plugin";
import {
  engineRunnerAt,
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

// ── #4609: the pull request environment ─────────────────────────────────────

describe("the review stack of a pull request's environment (#4609)", () => {
  test("pr-<n> replaces the step's own stack name, keeping its organization and project", () => {
    expect(prNumberOf("pr-12")).toBe(12);
    for (const no of ["prod", "pr-0", "pr-x", "pr-12-a", undefined]) expect(prNumberOf(no), String(no)).toBeUndefined();
    expect(reviewStackFor("dev", "pr-12")).toBe("pr-12");
    expect(reviewStackFor("acme/shop/dev", "pr-12")).toBe("acme/shop/pr-12");
    expect(reviewStackFor("dev", "pr-12", "web")).toBe("pr-12-web");
    expect(reviewStackFor("dev", "prod")).toBeUndefined();
    expect(() => reviewStackFor("dev", "pr-12", "Web_1")).toThrow(/reviewSuffix/);
  });

  test("a <project>/<stack> template names a Pulumi stack; a plain name or a review stack does not", () => {
    expect(pulumiTemplateStack("shop/dev")).toEqual({ project: "shop", stack: "dev" });
    expect(pulumiTemplateStack("acme/shop/dev")).toEqual({ org: "acme", project: "shop", stack: "dev" });
    for (const no of ["staging", "a/b/c/d", "shop/pr-3", "shop/", "/dev", undefined]) expect(pulumiTemplateStack(no), String(no)).toBeUndefined();
    expect(pulumiPlugin.prEnvTemplate!("shop/dev")).toBe("the Pulumi stack shop/dev");
    expect(pulumiPlugin.prEnvTemplate!("staging")).toBeUndefined();
  });

  test("the config comes from the template's stack in its own project, else from the step's own stack", () => {
    expect(reviewConfigSource({ stack: "dev", project: "shop" }, "shop/staging", "pr-12")).toBe("staging");
    expect(reviewConfigSource({ stack: "acme/shop/dev", project: "shop" }, "shop/staging", "acme/shop/pr-12")).toBe("acme/shop/staging");
    expect(reviewConfigSource({ stack: "dev", project: "shop" }, "acme/shop/staging", "pr-12")).toBe("acme/shop/staging");
    // Another project's template, or a chant environment name: the step's own stack.
    expect(reviewConfigSource({ stack: "dev", project: "api" }, "shop/staging", "pr-12")).toBe("dev");
    expect(reviewConfigSource({ stack: "dev", project: "shop" }, "staging", "pr-12")).toBe("dev");
    expect(reviewConfigSource({ stack: "pr-12", project: "shop" }, undefined, "pr-12")).toBeUndefined();
  });

  test("a location reads back as engine, directory and stack", () => {
    expect(reviewStackLocation("plunge", "infra/site", "pr-12")).toBe("plunge:infra/site#pr-12");
    expect(parseReviewStackLocation("plunge:infra/site#pr-12")).toEqual({ engine: "plunge", dir: "infra/site", stack: "pr-12" });
    for (const no of ["infra/site#pr-12", "tofu:x#pr-1", "pulumi:x", "pulumi:#pr-1"]) expect(parseReviewStackLocation(no), no).toBeUndefined();
  });
});

function live(over: Partial<LivePrEnvironment> = {}): LivePrEnvironment {
  return {
    pr: 12,
    env: "pr-12",
    template: "shop/dev",
    marker: { stack: "shop", env: "pr-12" },
    commit: "a".repeat(40),
    components: ["site"],
    applied: "2026-10-27T10:00:00.000Z",
    expiresAt: "2026-10-30T10:00:00.000Z",
    ...over,
  };
}

describe("the review stack teardown (#4609)", () => {
  test("pr-env down destroys and removes each review stack the record names, through core's ownership check", async () => {
    const pulumi = fake();
    const plunge = fake();
    const adapter = reviewStackTeardown({ cwd: "/work", run: pulumi.run, plunge: plunge.run });
    const torn = await tearDownPrEnvironment({
      pr: 12,
      live: live({ components: ["site", "api"], locations: { site: "pulumi:infra/site#pr-12, pulumi:infra/edge#pr-12-edge", api: "plunge:api#acme/api/pr-12" } }),
      adapters: [adapter],
    });
    if ("refusal" in torn) throw new Error(torn.refusal);
    expect(torn.report.outcomes.map((o) => [o.lexicon, o.name, o.outcome])).toEqual(
      expect.arrayContaining([
        [REVIEW_STACK_TEARDOWN, "infra/site#pr-12", "deleted"],
        [REVIEW_STACK_TEARDOWN, "infra/edge#pr-12-edge", "deleted"],
        [REVIEW_STACK_TEARDOWN, "api#acme/api/pr-12", "deleted"],
      ]),
    );
    expect(torn.dropped).toBe(0);
    // The teardown plan orders its entries by name (lifecycle/teardown.ts), so infra/edge comes first.
    expect(pulumi.calls).toEqual([
      ["destroy", "--yes", "--json", "--stack", "pr-12-edge"],
      ["stack", "rm", "--yes", "--stack", "pr-12-edge"],
      ["destroy", "--yes", "--json", "--stack", "pr-12"],
      ["stack", "rm", "--yes", "--stack", "pr-12"],
    ]);
    expect(plunge.calls).toEqual([
      ["destroy", "--yes", "--json", "--stack", "acme/api/pr-12"],
      ["stack", "rm", "--yes", "--stack", "acme/api/pr-12"],
    ]);
  });

  test("a stack of another name, another pull request or outside the project is a hole, and nothing runs for it", async () => {
    const pulumi = fake();
    const adapter = reviewStackTeardown({ cwd: "/work", run: pulumi.run });
    const found = await adapter.owned({
      environment: "pr-12",
      marker: { stack: "shop", env: "pr-12" },
      live: live({ locations: { a: "pulumi:infra#prod", b: "pulumi:infra#pr-13", c: "pulumi:../elsewhere#pr-12", d: "pulumi:/abs#pr-12", e: "not a location", f: "terraform-key-x" } }),
    });
    expect(found.candidates).toEqual([]);
    expect(found.holes?.map((h) => h.name).sort()).toEqual(["a: pulumi:infra#prod", "b: pulumi:infra#pr-13", "c: pulumi:../elsewhere#pr-12", "d: pulumi:/abs#pr-12"]);
    // A location another adapter wrote (no pulumi: or plunge: prefix) is not this teardown's.
    expect(found.holes?.some((h) => h.name.startsWith("f:"))).toBe(false);
    const torn = await tearDownPrEnvironment({ pr: 12, live: live({ locations: { a: "pulumi:infra#prod" } }), adapters: [reviewStackTeardown({ cwd: "/work", run: pulumi.run })] });
    if ("refusal" in torn) throw new Error(torn.refusal);
    expect(torn.report.plan.holes.length).toBe(1);
    expect(pulumi.calls).toEqual([]);
  });

  test("a stack already gone counts as deleted, and a failed destroy as failed", async () => {
    const gone = fake({ "destroy --yes": "error: no stack named 'pr-12' found" });
    const adapter = reviewStackTeardown({ cwd: "/work", run: gone.run });
    const found = await adapter.owned({ environment: "pr-12", marker: { stack: "shop", env: "pr-12" }, live: live({ locations: { site: "pulumi:infra#pr-12" } }) });
    const done = await adapter.teardown({ environment: "pr-12", marker: { stack: "shop", env: "pr-12" }, live: live(), candidates: found.candidates });
    expect(done.outcomes).toEqual([{ name: "infra#pr-12", outcome: "deleted", detail: "the stack was already gone" }]);
    const broken = fake({ "destroy --yes": "error: the update failed" });
    const a2 = reviewStackTeardown({ cwd: "/work", run: broken.run });
    const f2 = await a2.owned({ environment: "pr-12", marker: { stack: "shop", env: "pr-12" }, live: live({ locations: { site: "pulumi:infra#pr-12" } }) });
    const d2 = await a2.teardown({ environment: "pr-12", marker: { stack: "shop", env: "pr-12" }, live: live(), candidates: f2.candidates });
    expect(d2.outcomes[0]).toMatchObject({ name: "infra#pr-12", outcome: "failed" });
  });

  test("against a fake pulumi binary, the teardown runs exactly destroy then stack rm in the program's directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "review-stack-bin-"));
    const bin = join(root, "pulumi");
    const log = join(root, "calls.log");
    writeFileSync(bin, `#!/bin/sh\necho "$PWD|$*" >> "$FAKE_PULUMI_LOG"\nexit 0\n`);
    chmodSync(bin, 0o755);
    const adapter = reviewStackTeardown({ cwd: root, run: engineRunnerAt(bin), env: { FAKE_PULUMI_LOG: log, PULUMI_BACKEND_URL: `file://${root}`, PULUMI_SKIP_UPDATE_CHECK: "true" } });
    const torn = await tearDownPrEnvironment({ pr: 12, live: live({ locations: { site: "pulumi:.#pr-12" } }), adapters: [adapter] });
    if ("refusal" in torn) throw new Error(torn.refusal);
    expect(torn.report.outcomes.map((o) => o.outcome)).toEqual(["deleted"]);
    const lines = readFileSync(log, "utf-8").trim().split("\n");
    expect(lines.map((l) => l.split("|")[1])).toEqual(["destroy --yes --json --stack pr-12", "stack rm --yes --stack pr-12"]);
  });

  test("the plugin gives core the teardown, under a name apart from the lexicon's", () => {
    const adapter = pulumiPlugin.prEnvTeardown!({ cwd: "/work" });
    expect(adapter?.name).toBe(REVIEW_STACK_TEARDOWN);
    expect(adapter?.name).not.toBe(pulumiPlugin.name);
  });
});
