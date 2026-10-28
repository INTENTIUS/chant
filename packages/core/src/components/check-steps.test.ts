import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCheckStage, runCheckSteps, type CheckStepsAdapter } from "./check-steps";

const members = [
  { name: "web", dir: "/w/web", kind: "pulumi", fields: null },
  { name: "net", dir: "/w/net", kind: "choudoufu", fields: null },
];

function adapter(outcome: "passed" | "failed", seen: string[] = []): CheckStepsAdapter {
  return {
    lexicon: "fake",
    kinds: ["pulumi"],
    async run(ctx) {
      seen.push(...ctx.members.map((m) => m.name), `env:${Object.keys(ctx.env).sort().join(",")}`);
      return ctx.members.map((m) => ({ lexicon: "fake", step: "install", member: m.name, stack: "dev", exit: outcome === "passed" ? 0 : 2, outcome, ...(outcome === "failed" ? { reason: `install failed for member ${m.name}, stack dev` } : {}) }));
    },
  };
}

describe("lexicon check steps (#4633)", () => {
  test("an adapter runs for the members of its kinds only", async () => {
    const seen: string[] = [];
    const out = await runCheckSteps({ adapters: [adapter("passed", seen)], members, env: { PATH: "/bin" }, log: () => {} });
    expect(seen).toEqual(["web", "env:PATH"]);
    expect(out).toEqual([expect.objectContaining({ member: "web", outcome: "passed" })]);
  });

  test("an adapter that throws fails each of its members, naming the lexicon", async () => {
    const broken: CheckStepsAdapter = { lexicon: "fake", kinds: ["pulumi"], run: async () => { throw new Error("boom"); } };
    const out = await runCheckSteps({ adapters: [broken], members, env: {}, log: () => {} });
    expect(out).toEqual([expect.objectContaining({ member: "web", outcome: "failed", reason: "the fake check steps for web could not run: boom" })]);
  });

  test("the stage runs the steps after passing hooks, and the report carries both", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "chant-check-steps-"));
    const report = await runCheckStage({
      base: "abc123",
      cwd,
      read: { base: "abc123", hooks: [{ name: "fmt", command: ["fmt"] }] },
      exec: () => 0,
      adapters: [adapter("failed")],
      members,
      env: { GITHUB_TOKEN: "t" },
      log: () => {},
    });
    expect(report.status).toBe("failed");
    expect(report.hooks.map((h) => h.outcome)).toEqual(["passed"]);
    expect(report.failed).toBe("a check step failed: install failed for member web, stack dev");
    const written = JSON.parse(readFileSync(join(cwd, ".chant/check/check-hooks.json"), "utf8"));
    expect(written.steps).toHaveLength(1);
  });

  test("a failed hook stops the stage before the steps", async () => {
    const seen: string[] = [];
    const cwd = mkdtempSync(join(tmpdir(), "chant-check-steps-"));
    const report = await runCheckStage({ base: "abc", cwd, read: { base: "abc", hooks: [{ name: "lint", command: ["lint"] }] }, exec: () => 1, adapters: [adapter("passed", seen)], members, log: () => {} });
    expect(report.status).toBe("failed");
    expect(report.steps).toBeUndefined();
    expect(seen).toEqual([]);
  });

  test("with no hooks and no members of the adapter's kinds, nothing ran", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "chant-check-steps-"));
    const report = await runCheckStage({ base: "abc", cwd, read: { base: "abc", hooks: [] }, adapters: [adapter("passed")], members: [members[1]!], log: () => {} });
    expect(report.status).toBe("none");
  });
});
