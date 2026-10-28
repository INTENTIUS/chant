/**
 * The pulumi check steps (#4633): install, stack config against the
 * project's schema, and about, with a fake runner, so no binary runs and no
 * backend is read or written.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCheckStage } from "@intentius/chant/components/check-steps";
import { listedStacks, pulumiAboutDetail, pulumiCheckSteps, pulumiMemberCheck, pulumiProjectSchema, pulumiStackConfigProblems } from "./check-step";
import { pulumiPlugin } from "./plugin";
import { allowedCheck, runCheckPulumi, type PulumiRunner } from "./run";

const PROJECT = `name: shop
runtime: nodejs
config:
  aws:region: us-east-1
  replicas:
    type: integer
  size:
    type: string
    default: small
  dbPassword:
    type: string
    secret: true
  zones:
    type: array
    items:
      type: string
`;

const ABOUT = JSON.stringify({
  cli: { version: "3.140.0" },
  plugins: [{ name: "aws", version: "6.60.0" }, { name: "nodejs", version: "unknown" }],
  backend: { name: "laptop", url: "file:///tmp/state", user: "ci" },
});

function member(files: Record<string, string>, fields: Record<string, unknown> | null = null) {
  const dir = mkdtempSync(join(tmpdir(), "chant-pulumi-check-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return { name: "shop", dir, kind: "pulumi", fields };
}

function fake(answers: Record<string, { stdout?: string; fail?: { code?: number | string; stderr?: string; stdout?: string } }>) {
  const calls: Array<{ engine: string; args: string[]; env?: Record<string, string> }> = [];
  const runner = (engine: string, env: Record<string, string>): PulumiRunner => async (args) => {
    calls.push({ engine, args, env });
    const a = answers[args.join(" ")] ?? { stdout: "" };
    if (a.fail) throw Object.assign(new Error(`${engine} ${args.join(" ")} failed`), a.fail);
    return { stdout: a.stdout ?? "" };
  };
  return { calls, runner };
}

const ctx = { env: { PATH: "/bin" }, log: () => {} };

describe("the check argv (#4633)", () => {
  test("install and about --json, optionally with a stack, and nothing else", () => {
    expect(allowedCheck(["install"])).toBe(true);
    expect(allowedCheck(["about", "--json"])).toBe(true);
    expect(allowedCheck(["about", "--json", "--stack", "dev"])).toBe(true);
    expect(allowedCheck(["install", "--reinstall"])).toBe(false);
    expect(allowedCheck(["about"])).toBe(false);
    expect(allowedCheck(["about", "--json", "--stack", "--yes"])).toBe(false);
    expect(allowedCheck(["up", "--yes"])).toBe(false);
  });

  test("runCheckPulumi refuses an argv off the list before the runner sees it", async () => {
    let ran = false;
    const run: PulumiRunner = async () => {
      ran = true;
      return { stdout: "" };
    };
    await expect(runCheckPulumi(run, ["up", "--yes"], "/tmp")).rejects.toThrow(/check stage runs only/);
    expect(ran).toBe(false);
  });
});

describe("stack config against the project's schema", () => {
  const schema = pulumiProjectSchema({ name: "shop", config: { "aws:region": "us-east-1", replicas: { type: "integer" }, size: { type: "string", default: "small" }, dbPassword: { type: "string", secret: true }, zones: { type: "array", items: { type: "string" } } } });

  test("reads the keys in full form", () => {
    expect(schema.keys.map((k) => k.key)).toEqual(["aws:region", "shop:replicas", "shop:size", "shop:dbPassword", "shop:zones"]);
    expect(schema.stackConfigDir).toBe(".");
  });

  test("a stack that sets every required key with the right types passes", () => {
    expect(pulumiStackConfigProblems(schema, "dev", { config: { "shop:replicas": "3", "shop:dbPassword": { secure: "AAAB" }, "shop:zones": ["a", "b"] } })).toEqual([]);
  });

  test("a missing key with no default, a wrong type and a plain-text secret are each named", () => {
    const problems = pulumiStackConfigProblems(schema, "prod", { config: { "shop:size": 3, "shop:dbPassword": "hunter2", "shop:zones": ["a", ["b"]] } });
    expect(problems).toEqual([
      "stack prod is missing the configuration value shop:replicas (type integer, no default)",
      "stack prod sets shop:dbPassword in plain text, and the project declares it secret; set it with pulumi config set --secret",
      'stack prod sets shop:zones[1] to ["b"], which is not of type string',
    ]);
    expect(pulumiStackConfigProblems(schema, "qa", { config: { replicas: "three" } })[0]).toBe('stack qa sets shop:replicas to "three", which is not of type integer');
  });

  test("the listed stacks are the stack files", () => {
    const m = member({ "Pulumi.yaml": PROJECT, "Pulumi.dev.yaml": "config: {}\n", "Pulumi.prod.yml": "config: {}\n" });
    expect(listedStacks(m.dir)).toEqual(["dev", "prod"]);
  });
});

describe("pulumi about --json", () => {
  test("reads the engine, plugins and backend", () => {
    expect(pulumiAboutDetail("pulumi", ABOUT)).toEqual({
      engine: "pulumi",
      version: "3.140.0",
      plugins: [{ name: "aws", version: "6.60.0" }, { name: "nodejs", version: "unknown" }],
      backend: { name: "laptop", url: "file:///tmp/state", user: "ci" },
    });
    expect(pulumiAboutDetail("pulumi", "not json")).toBeUndefined();
  });
});

describe("a member's steps", () => {
  test("install, each stack's config and about pass in order, with the check job's environment", async () => {
    const m = member({ "Pulumi.yaml": PROJECT, "Pulumi.dev.yaml": "config:\n  shop:replicas: \"2\"\n  shop:dbPassword:\n    secure: AAAB\n" });
    const { calls, runner } = fake({ "about --json": { stdout: ABOUT } });
    const out = await pulumiMemberCheck(m, ctx, { runner });
    expect(out.map((o) => [o.step, o.stack ?? "", o.outcome])).toEqual([
      ["pulumi-install", "", "passed"],
      ["stack-config", "dev", "passed"],
      ["pulumi-about", "", "passed"],
    ]);
    expect(calls.map((c) => c.args.join(" "))).toEqual(["install", "about --json"]);
    expect(calls.every((c) => c.engine === "pulumi" && c.env?.PATH === "/bin")).toBe(true);
  });

  test("a member on plunge runs plunge, and its declared stack goes to about", async () => {
    const m = member({ "Pulumi.yaml": PROJECT }, { engine: "plunge", stack: "dev" });
    const { calls, runner } = fake({ "about --json --stack dev": { stdout: ABOUT } });
    const out = await pulumiMemberCheck(m, ctx, { runner });
    expect(calls.map((c) => `${c.engine} ${c.args.join(" ")}`)).toEqual(["plunge install", "plunge about --json --stack dev"]);
    // dev has no stack file, and replicas has no default.
    expect(out.find((o) => o.step === "stack-config")).toMatchObject({ stack: "dev", outcome: "failed", reason: expect.stringContaining("member shop: stack dev is missing the configuration value shop:replicas") });
  });

  test("a failed install names the member, and about does not run", async () => {
    const m = member({ "Pulumi.yaml": PROJECT, "Pulumi.dev.yaml": "config:\n  shop:replicas: 1\n  shop:dbPassword:\n    secure: x\n" });
    const { calls, runner } = fake({ install: { fail: { code: 255, stderr: "error: npm install failed\n" } } });
    const out = await pulumiMemberCheck(m, ctx, { runner });
    expect(out[0]).toMatchObject({ step: "pulumi-install", outcome: "failed", exit: 255, reason: "pulumi install failed for member shop: error: npm install failed" });
    expect(out.at(-1)).toMatchObject({ step: "pulumi-about", outcome: "skipped" });
    expect(calls.map((c) => c.args.join(" "))).toEqual(["install"]);
  });

  test("about that exits non-zero but prints its JSON still reports", async () => {
    const m = member({ "Pulumi.yaml": "name: shop\nruntime: nodejs\n" });
    const { runner } = fake({ "about --json": { fail: { code: 1, stdout: ABOUT, stderr: "error: not logged in" } } });
    const out = await pulumiMemberCheck(m, ctx, { runner });
    expect(out.find((o) => o.step === "pulumi-about")).toMatchObject({ outcome: "passed", exit: 1, detail: { version: "3.140.0" } });
    expect(out.find((o) => o.step === "stack-config")).toMatchObject({ outcome: "skipped" });
  });

  test("a member with no Pulumi.yaml fails, naming it", async () => {
    const m = member({ "README.md": "x" });
    const out = await pulumiMemberCheck(m, ctx, { runner: fake({}).runner });
    expect(out).toEqual([expect.objectContaining({ step: "pulumi-install", outcome: "failed", reason: expect.stringContaining("has no Pulumi.yaml") })]);
  });
});

describe("in the check stage", () => {
  test("the plugin gives the steps for the pulumi kind", () => {
    expect(pulumiPlugin.checkSteps?.()).toMatchObject({ lexicon: "pulumi", kinds: ["pulumi"] });
  });

  test("a failed step fails the stage after the hooks, naming member and stack", async () => {
    const m = member({ "Pulumi.yaml": PROJECT, "Pulumi.prod.yaml": "config: {}\n" });
    const cwd = mkdtempSync(join(tmpdir(), "chant-pulumi-stage-"));
    const report = await runCheckStage({
      base: "abc123",
      cwd,
      read: { base: "abc123", hooks: [] },
      members: [m],
      adapters: [pulumiCheckSteps({ runner: fake({ "about --json": { stdout: ABOUT } }).runner })],
      env: {},
      log: () => {},
    });
    expect(report.status).toBe("failed");
    expect(report.failed).toContain("member shop: stack prod is missing the configuration value shop:replicas");
    expect(report.steps?.map((s) => s.step)).toEqual(["pulumi-install", "stack-config", "pulumi-about"]);
  });
});
