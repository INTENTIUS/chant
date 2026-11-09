/**
 * #4870: `ci.hooks.check`'s runner signs each hook whose every run passed as
 * a named check by the hook's name, attached where the ref gate (#4867)
 * reads it, and the key never reaches a hook. Without a signer the report is
 * as before.
 */

import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { checkHookEnv } from "./check-hooks";
import { runCheckStage } from "./check-steps";
import { loadRunnerKey } from "../workspace/trust/dsse";
import { readCheckEvidence, runnerKeyEvidenceSigner } from "../workspace/trust/check-evidence";
import { decideRefUpdate } from "../workspace/trust/ref-gate";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function repo(): { cwd: string; head: string; pem: string } {
  const cwd = mkdtempSync(join(tmpdir(), "chant-4870-check-"));
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  git(cwd, "init", "--quiet");
  mkdirSync(join(cwd, ".chant"));
  writeFileSync(join(cwd, ".chant/trust.json"), JSON.stringify({ schema: 1, runners: [{ principal: "ci", class: "runner", key: loadRunnerKey(pem).publicKey }] }));
  git(cwd, "add", ".");
  git(cwd, "commit", "--quiet", "-m", "base");
  return { cwd, head: git(cwd, "rev-parse", "HEAD"), pem };
}

const hooks = [
  { name: "fmt", command: ["fmt"] },
  { name: "tflint", command: ["tflint", "{target}"], perRun: true },
  { name: "checkov", command: ["checkov"] },
];

describe("the check runner signs per hook (#4870)", () => {
  test("each hook that passed is signed, and one that failed is not", async () => {
    const { cwd, head, pem } = repo();
    const logs: string[] = [];
    const report = await runCheckStage({
      base: head,
      targets: ["roots/a", "roots/b"],
      cwd,
      adapters: [],
      read: { base: head, hooks },
      exec: (argv) => (argv[0] === "checkov" ? 1 : 0),
      log: (l) => logs.push(l),
      evidence: { signer: runnerKeyEvidenceSigner(cwd, head, pem), push: false },
    });
    expect(report.status).toBe("failed");
    expect(report.evidence).toEqual({ signed: ["fmt", "tflint"], runner: "ci", commit: head });
    expect(logs).toContain(`ci check: signed evidence for tflint at ${head.slice(0, 12)} as ci`);
    expect((await readCheckEvidence(cwd, head, head, ["fmt", "tflint", "checkov"])).map((v) => v.status)).toEqual(["current", "current", "missing"]);
    expect(JSON.parse(readFileSync(join(cwd, ".chant/check/check-hooks.json"), "utf8")).evidence.signed).toEqual(["fmt", "tflint"]);
    // The ref gate reads the same notes: a rule at base naming fmt and tflint admits the commit.
    const policy = JSON.parse(readFileSync(join(cwd, ".chant/trust.json"), "utf8"));
    writeFileSync(join(cwd, ".chant/trust.json"), JSON.stringify({ ...policy, refs: [{ ref: "refs/heads/main", checks: [{ check: "fmt", command: "chant ci check" }, { check: "tflint", command: "chant ci check" }, { check: "checkov", command: "chant ci check" }] }] }));
    git(cwd, "commit", "--quiet", "-am", "require the checks");
    const ruled = git(cwd, "rev-parse", "HEAD");
    const decided = decideRefUpdate({ repo: cwd, base: ruled, update: { ref: "refs/heads/main", old: ruled, new: head } });
    expect(decided.checks.map((c) => [c.check, c.status])).toEqual([["fmt", "current"], ["tflint", "current"], ["checkov", "missing"]]);
  });

  test("without a signer nothing is signed and the report has no evidence", async () => {
    const { cwd, head } = repo();
    const report = await runCheckStage({ base: head, cwd, adapters: [], read: { base: head, hooks: [hooks[0]!] }, exec: () => 0, log: () => {} });
    expect(report).not.toHaveProperty("evidence");
    expect(JSON.parse(readFileSync(join(cwd, ".chant/check/check-hooks.json"), "utf8"))).not.toHaveProperty("evidence");
  });

  test("a hook never sees the runner key", () => {
    expect(checkHookEnv({ PATH: "/bin", CHANT_RUNNER_KEY: "-----BEGIN PRIVATE KEY-----" })).toEqual({ PATH: "/bin" });
  });
});
