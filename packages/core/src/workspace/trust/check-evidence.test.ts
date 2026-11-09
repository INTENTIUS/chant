/**
 * #4870: evidence for each named check, kept on chant/lifecycle by the
 * commit's tree and verified against the runner keys at base. The attacker
 * controls the change: a runner key the change adds, a tree that differs
 * from the one signed, and a person's key posing as a runner's.
 */

import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadRunnerKey } from "./dsse";
import { checkStatement, missingCheckEvidence, readCheckEvidence, recordChecks, runnerKeyEvidenceSigner, signChecks } from "./check-evidence";
import { CHECK_EVIDENCE_FILE, checkEvidenceNoteLine, planReportChecks } from "./check-evidence-report";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function runnerKey(): { pem: string; pub: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  return { pem, pub: loadRunnerKey(pem).publicKey };
}

function trust(runners: Array<{ principal: string; key: string }>): string {
  return JSON.stringify({ schema: 1, runners: runners.map((r) => ({ ...r, class: "runner" })) });
}

/** A repository whose base lists `ci`'s key as a runner, and a change on top of it. */
function repo(): { dir: string; base: string; head: string; ci: { pem: string; pub: string } } {
  const dir = mkdtempSync(join(tmpdir(), "chant-4870-"));
  const ci = runnerKey();
  git(dir, "init", "--quiet");
  mkdirSync(join(dir, ".chant"));
  writeFileSync(join(dir, ".chant/trust.json"), trust([{ principal: "ci", key: ci.pub }]));
  writeFileSync(join(dir, "main.tf"), "# base\n");
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", "base");
  const base = git(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, "main.tf"), "# change\n");
  git(dir, "commit", "--quiet", "-am", "change");
  return { dir, base, head: git(dir, "rev-parse", "HEAD"), ci };
}

describe("check evidence (#4870)", () => {
  test("a signed check is current for its commit, and for another commit with the same tree", async () => {
    const r = repo();
    const signer = runnerKeyEvidenceSigner(r.dir, r.base, r.ci.pem);
    const signed = signChecks(r.dir, r.head, [{ check: "plan", claim: "{}" }, { check: "policy" }], signer);
    expect(signed.map((s) => s.check)).toEqual(["plan", "policy"]);
    await recordChecks(r.dir, signed, { push: false });
    expect(await readCheckEvidence(r.dir, r.head, r.base, ["plan", "policy"])).toEqual([
      { check: "plan", status: "current", runner: "ci", commit: r.head },
      { check: "policy", status: "current", runner: "ci", commit: r.head },
    ]);
    // A squash of the same change onto the base: another commit, the same tree.
    git(r.dir, "checkout", "--quiet", r.base);
    git(r.dir, "checkout", "--quiet", r.head, "--", "main.tf");
    git(r.dir, "commit", "--quiet", "-m", "squashed");
    const squash = git(r.dir, "rev-parse", "HEAD");
    expect(squash).not.toBe(r.head);
    expect((await readCheckEvidence(r.dir, squash, r.base, ["plan"]))[0]).toMatchObject({ status: "current", commit: r.head });
  });

  test("a commit whose tree differs has none, and the refusal names each missing check and its command", async () => {
    const r = repo();
    await recordChecks(r.dir, signChecks(r.dir, r.head, [{ check: "plan" }], runnerKeyEvidenceSigner(r.dir, r.base, r.ci.pem)), { push: false });
    expect((await readCheckEvidence(r.dir, r.base, r.base, ["plan"]))[0]!.status).toBe("missing");
    const refused = await missingCheckEvidence(r.dir, r.head, r.base, ["plan", "policy"]);
    expect(refused).toContain("policy");
    expect(refused).toContain("chant ci evidence sign --check-id policy");
    expect(refused).not.toMatch(/\bplan \(/);
    expect(await missingCheckEvidence(r.dir, r.head, r.base, ["plan"])).toBeNull();
  });

  test("a runner key the change adds signs nothing the base trusts", async () => {
    const r = repo();
    const added = runnerKey();
    writeFileSync(join(r.dir, ".chant/trust.json"), trust([{ principal: "ci", key: r.ci.pub }, { principal: "mine", key: added.pub }]));
    git(r.dir, "commit", "--quiet", "-am", "add my key");
    const head = git(r.dir, "rev-parse", "HEAD");
    expect(() => runnerKeyEvidenceSigner(r.dir, r.base, added.pem)).toThrow(/lists no runner with this key/);
    // Signed against the change's own policy, and kept: the base still does not trust it.
    await recordChecks(r.dir, signChecks(r.dir, head, [{ check: "plan" }], runnerKeyEvidenceSigner(r.dir, head, added.pem)), { push: false });
    expect((await readCheckEvidence(r.dir, head, r.base, ["plan"]))[0]).toMatchObject({ status: "untrusted" });
    expect(await readCheckEvidence(r.dir, head, head, ["plan"])).toEqual([{ check: "plan", status: "current", runner: "mine", commit: head }]);
  });

  test("the statement binds the commit, its tree and the check's name, and no record", () => {
    const s = checkStatement({ commit: "a".repeat(40), tree: "b".repeat(40), check: "check-root:prod", runner: "ci", claim: "x" });
    expect(s.subject).toEqual([]);
    expect(s.predicate).toMatchObject({ commit: "a".repeat(40), tree: "b".repeat(40), check: "check-root:prod", runner: "ci" });
    expect(s.predicate.claim?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the plan job's two checks (#4870)", () => {
  const dir = (files: Record<string, unknown>): string => {
    const d = mkdtempSync(join(tmpdir(), "chant-4870-report-"));
    for (const [name, body] of Object.entries(files)) writeFileSync(join(d, name), JSON.stringify(body));
    return d;
  };

  test("plan and policy from a pr-plan.json whose policy passed; only plan when it denied or ran none", () => {
    expect(planReportChecks(dir({ "pr-plan.json": { policy: { result: "passed" } } }), "success").sign.map((c) => c.check)).toEqual(["plan", "policy"]);
    const denied = planReportChecks(dir({ "pr-plan.json": { policy: { result: "denied" } } }), "success");
    expect(denied.sign.map((c) => c.check)).toEqual(["plan"]);
    expect(denied.skipped).toEqual([{ check: "policy", reason: "the policy denied the plan" }]);
    expect(planReportChecks(dir({ "pr-plan.json": { policy: { result: "denied", override: { by: "a" } } } }), "success").sign.map((c) => c.check)).toEqual(["plan", "policy"]);
    expect(planReportChecks(dir({ "pr-plan.json": {} }), "success").skipped).toEqual([{ check: "policy", reason: "the plan ran no policy" }]);
  });

  test("a plan note hand-off: policy passes when every denial has its override", () => {
    const handoff = (overrides: unknown[]) => ({ "pr-plan-note.json": { kind: "plan-note-handoff", note: { waves: [{ policy: { outcome: "held", rules: [] } }], overrides } } });
    expect(planReportChecks(dir(handoff([{ member: "a", rules: ["r"], override: { by: "x" }, overriders: [] }])), "success").sign.map((c) => c.check)).toEqual(["plan", "policy"]);
    expect(planReportChecks(dir(handoff([{ member: "a", rules: ["r"], overriders: [] }])), "success").sign.map((c) => c.check)).toEqual(["plan"]);
  });

  test("a failed plan job signs neither, and the note line says which were signed", () => {
    const failed = planReportChecks(dir({ "pr-plan.json": { policy: { result: "passed" } } }), "failure");
    expect(failed.sign).toEqual([]);
    expect(failed.skipped.map((s) => s.check)).toEqual(["plan", "policy"]);
    const d = dir({});
    expect(checkEvidenceNoteLine(d)).toBeUndefined();
    writeFileSync(join(d, CHECK_EVIDENCE_FILE), JSON.stringify({ signed: [{ check: "plan", runner: "ci", commit: "c", tree: "t" }], skipped: [{ check: "policy", reason: "the policy denied the plan" }] }));
    expect(checkEvidenceNoteLine(d)).toBe("Checks: signed evidence for `plan` as ci; not signed: `policy` (the policy denied the plan).");
    expect(readFileSync(join(d, CHECK_EVIDENCE_FILE), "utf-8")).toContain("plan");
  });
});
