/**
 * #4868: the check runner skips a hook whose current local evidence the
 * policy at base accepts, per hook, so a job that runs several hooks runs
 * the rest and still passes; and runs it for a tree without such evidence.
 */

import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { checkHookEnv, runCheckHooks } from "./check-hooks";
import { runCheckStage } from "./check-steps";
import { loadRunnerKey } from "../workspace/trust/dsse";
import { localKeyEvidenceSigner, recordLocalChecks, signLocalChecks } from "../workspace/trust/local-evidence";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function pemKey(): string {
  return generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString();
}

/** A repository whose policy at its first commit lists alice's local key and takes local evidence for fmt and tflint. */
function repo(): { cwd: string; base: string; alice: string } {
  const cwd = mkdtempSync(join(tmpdir(), "chant-4868-stage-"));
  const alice = pemKey();
  git(cwd, "init", "--quiet");
  mkdirSync(join(cwd, ".chant"));
  writeFileSync(
    join(cwd, ".chant/trust.json"),
    JSON.stringify({ schema: 1, local: { keys: [{ principal: "alice", class: "person", key: loadRunnerKey(alice).publicKey }], checks: [{ check: "fmt" }, { check: "tflint" }] } }),
  );
  writeFileSync(join(cwd, "main.tf"), "# a\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "--quiet", "-m", "base");
  return { cwd, base: git(cwd, "rev-parse", "HEAD"), alice };
}

const hooks = [
  { name: "fmt", command: ["fmt"] },
  { name: "tflint", command: ["tflint", "{target}"], perRun: true },
  { name: "checkov", command: ["checkov"] },
];

async function signLocally(cwd: string, base: string, pem: string, checks: string[]): Promise<void> {
  const signer = localKeyEvidenceSigner(cwd, base, pem);
  await recordLocalChecks(cwd, signLocalChecks(cwd, "HEAD", checks.map((check) => ({ check })), signer), { push: false });
}

async function stage(cwd: string, base: string) {
  const ran: string[] = [];
  const logs: string[] = [];
  const report = await runCheckStage({
    base,
    targets: ["roots/a", "roots/b"],
    cwd,
    adapters: [],
    read: { base, hooks },
    exec: (argv) => {
      ran.push(argv.join(" "));
      return 0;
    },
    log: (l) => logs.push(l),
    localEvidence: { base, fetch: false },
  });
  return { report, ran, logs };
}

describe("the check runner skips a hook on local evidence (#4868)", () => {
  test("a hook with current, accepted local evidence is skipped; the others run and the job passes", async () => {
    const { cwd, base, alice } = repo();
    await signLocally(cwd, base, alice, ["fmt", "checkov"]);
    const { report, ran, logs } = await stage(cwd, base);
    expect(report.status).toBe("passed");
    // checkov has local evidence too, and the policy does not take it for checkov.
    expect(ran).toEqual(["tflint roots/a", "tflint roots/b", "checkov"]);
    expect(report.hooks.map((h) => [h.name, h.outcome])).toEqual([["fmt", "skipped"], ["tflint", "passed"], ["tflint", "passed"], ["checkov", "passed"]]);
    expect(report.hooks[0]!.localEvidence).toEqual({ signer: "alice", class: "person", commit: base });
    expect(logs.some((l) => l.includes("check hook fmt: skipped, current local evidence from person alice"))).toBe(true);
    expect(JSON.parse(readFileSync(join(cwd, ".chant/check/check-hooks.json"), "utf8")).hooks[0].outcome).toBe("skipped");
  });

  test("every hook skipped still passes, so a job other jobs need succeeds", async () => {
    const { cwd, base, alice } = repo();
    await signLocally(cwd, base, alice, ["fmt", "tflint"]);
    const { report, ran } = await stage(cwd, base);
    expect(ran).toEqual(["checkov"]);
    expect(report.status).toBe("passed");
  });

  test("a tree changed after signing runs the hook", async () => {
    const { cwd, base, alice } = repo();
    await signLocally(cwd, base, alice, ["fmt"]);
    writeFileSync(join(cwd, "main.tf"), "# b\n");
    git(cwd, "commit", "--quiet", "-am", "change the tree");
    const { ran } = await stage(cwd, base);
    expect(ran[0]).toBe("fmt");
  });

  test("an amend that keeps the tree keeps the evidence current", async () => {
    const { cwd, base, alice } = repo();
    writeFileSync(join(cwd, "main.tf"), "# b\n");
    git(cwd, "commit", "--quiet", "-am", "work");
    await signLocally(cwd, base, alice, ["fmt"]);
    git(cwd, "commit", "--quiet", "--amend", "-m", "work, reworded");
    const { ran } = await stage(cwd, base);
    expect(ran).not.toContain("fmt");
  });

  test("without localEvidence every hook runs", async () => {
    const { cwd, base, alice } = repo();
    await signLocally(cwd, base, alice, ["fmt"]);
    const ran: string[] = [];
    await runCheckStage({ base, cwd, adapters: [], read: { base, hooks: [hooks[0]!] }, exec: (argv) => (ran.push(argv[0]!), 0), log: () => {} });
    expect(ran).toEqual(["fmt"]);
  });

  test("a local signer signs each passed hook as local evidence, and CI then skips it", async () => {
    const { cwd, base, alice } = repo();
    const signed = await runCheckStage({ base, cwd, adapters: [], read: { base, hooks: [hooks[0]!] }, exec: () => 0, log: () => {}, evidence: { signer: localKeyEvidenceSigner(cwd, base, alice), push: false } });
    expect(signed.evidence?.signed).toEqual(["fmt"]);
    const { ran } = await stage(cwd, base);
    expect(ran).not.toContain("fmt");
  });

  test("runCheckHooks, which a product's own check job calls, skips the same way", async () => {
    const { cwd, base, alice } = repo();
    await signLocally(cwd, base, alice, ["fmt"]);
    const ran: string[] = [];
    const report = runCheckHooks({ base, cwd, read: { base, hooks: [hooks[0]!, hooks[2]!] }, exec: (argv) => (ran.push(argv[0]!), 0), log: () => {}, localEvidence: { base, fetch: false } });
    expect(ran).toEqual(["checkov"]);
    expect(report.hooks.map((h) => h.outcome)).toEqual(["skipped", "passed"]);
  });

  test("a hook never sees the local evidence key", () => {
    expect(checkHookEnv({ PATH: "/bin", CHANT_LOCAL_EVIDENCE_KEY: "-----BEGIN PRIVATE KEY-----" })).toEqual({ PATH: "/bin" });
  });
});
