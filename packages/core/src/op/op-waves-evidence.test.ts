/**
 * #4870: an apply whose spec at base requires a check's evidence refuses a
 * commit without it, and a wave job with a runner key signs its own plan
 * and policy checks. Real local repositories; the spec at base is read with
 * git itself.
 */

import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "./op-waves";
import { assertOpWavesSpec } from "./op-waves";
import { runOpWave, type OpWaveRunPort, type OpWaveShowAtBase } from "./op-waves-run";
import { memoryGateLedgerPort } from "./gate";
import { CHANT_EXIT } from "../exit-codes";
import { CapabilityRegistry, type Capability } from "../components/capability";
import { loadRunnerKey } from "../workspace/trust/dsse";
import { readCheckEvidence, recordChecks, runnerKeyEvidenceSigner, signChecks } from "../workspace/trust/check-evidence";
import { signOpWaveChecks } from "./op-waves-evidence";

const digest = (n: string) => `sha256:${n.repeat(64)}`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const spec: OpWavesSpec = {
  name: "roots",
  op: "tf-apply",
  step: { kind: "fake-apply", root: "{target}" },
  evidence: { requires: ["plan", "policy"] },
  waves: [{ name: "dev", runs: [{ target: "network" }], gate: "never" }],
};

/** A base commit with the spec and a runner key in .chant/trust.json, and a merge on top of it. */
function repo(): { cwd: string; base: string; head: string; pem: string } {
  const cwd = mkdtempSync(join(tmpdir(), "chant-4870-waves-"));
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  git(cwd, "init", "--quiet");
  mkdirSync(join(cwd, ".chant"));
  writeFileSync(join(cwd, ".chant/trust.json"), JSON.stringify({ schema: 1, runners: [{ principal: "ci", class: "runner", key: loadRunnerKey(pem).publicKey }] }));
  writeFileSync(join(cwd, "waves.json"), JSON.stringify(spec));
  git(cwd, "add", ".");
  git(cwd, "commit", "--quiet", "-m", "base");
  const base = git(cwd, "rev-parse", "HEAD");
  writeFileSync(join(cwd, "main.tf"), "# change\n");
  git(cwd, "add", "main.tf");
  git(cwd, "commit", "--quiet", "-m", "merge");
  return { cwd, base, head: git(cwd, "rev-parse", "HEAD"), pem };
}

const atBase: OpWaveShowAtBase = (ref, path, cwd) => {
  const sha = git(cwd, "rev-parse", ref);
  try {
    return { sha, text: execFileSync("git", ["show", `${sha}:${path}`], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }) };
  } catch {
    return { sha, text: null };
  }
};

function fakeCapability(): { registry: CapabilityRegistry; ran: string[] } {
  const ran: string[] = [];
  const cap: Capability<Record<string, unknown>, unknown> = {
    kind: "fake-apply",
    async plan(_ctx, input) {
      return { member: String(input.root), planDigest: digest("1"), artifact: {} };
    },
    async run(_ctx, input) {
      ran.push(String(input.root));
      return { applied: input.root };
    },
  };
  return { registry: new CapabilityRegistry().register(cap), ran };
}

const runs: OpWaveRunPort = { append: async () => undefined };

async function wave(cwd: string, head: string) {
  const { registry, ran } = fakeCapability();
  const logs: string[] = [];
  const result = await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd, head, show: atBase, gates: memoryGateLedgerPort(), capabilities: registry, runs, log: (l) => logs.push(l) });
  return { result, ran, logs };
}

describe("evidence.requires (#4870)", () => {
  test("the spec takes evidence.requires and refuses a name that is not a check's", () => {
    expect(() => assertOpWavesSpec(spec)).not.toThrow();
    expect(() => assertOpWavesSpec({ ...spec, evidence: { requires: ["has space"] } })).toThrow(/evidence.requires/);
    expect(() => assertOpWavesSpec({ ...spec, evidence: { want: [] } as never })).toThrow(/evidence.want/);
  });

  test("an apply whose policy at base requires the plan check's evidence refuses a commit without it", async () => {
    const { cwd, head } = repo();
    const { result, ran, logs } = await wave(cwd, head);
    expect(result.exitCode).toBe(1);
    expect(ran).toEqual([]);
    const line = logs.find((l) => l.includes("lacks the evidence"));
    expect(line).toContain("plan (no evidence for check plan");
    expect(line).toContain("chant ci evidence sign --check-id policy");
    expect(line).toContain("nothing in it was planned or applied");
  });

  test("the same commit applies once its tree has current evidence for each required check", async () => {
    const { cwd, base, head, pem } = repo();
    await recordChecks(cwd, signChecks(cwd, head, [{ check: "plan" }, { check: "policy" }], runnerKeyEvidenceSigner(cwd, base, pem)), { push: false });
    const { result, ran } = await wave(cwd, head);
    expect(result.exitCode).toBe(0);
    expect(ran).toEqual(["network"]);
  });

  test("a wave job with a runner key signs its plan check, and its policy check only when ci.policy ran and denied nothing", async () => {
    const { cwd, base, head, pem } = repo();
    const logs: string[] = [];
    const env = { CHANT_RUNNER_KEY: pem } as NodeJS.ProcessEnv;
    const none = new Map();
    expect(await signOpWaveChecks({ cwd, head, base, wave: "dev", planDigest: digest("1"), policyRows: none, log: (l) => logs.push(l), env, push: false })).toEqual(["plan:dev"]);
    const passed = new Map([["network", { source: "ci.policy", result: "passed" as const, rules: [] }]]);
    expect(await signOpWaveChecks({ cwd, head, base, wave: "dev", policyRows: passed, log: (l) => logs.push(l), env, push: false })).toEqual(["plan:dev", "policy:dev"]);
    const denied = new Map([["network", { source: "ci.policy", result: "denied" as const, rules: ["r"] }]]);
    expect(await signOpWaveChecks({ cwd, head, base, wave: "dev", policyRows: denied, log: (l) => logs.push(l), env, push: false })).toEqual(["plan:dev"]);
    expect((await readCheckEvidence(cwd, head, base, ["plan:dev", "policy:dev"])).map((v) => v.status)).toEqual(["current", "current"]);
    expect(logs[0]).toBe("wave dev: signed evidence for plan:dev as ci");
    // No key, nothing signed and nothing said.
    expect(await signOpWaveChecks({ cwd, head, base, wave: "dev", policyRows: none, log: (l) => logs.push(l), env: {}, push: false })).toEqual([]);
  });
});
