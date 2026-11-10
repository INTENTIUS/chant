/**
 * #4868: local evidence, signed on a developer's or an agent's machine by a
 * key `.chant/trust.json` at base lists, stands in for a CI run of a check
 * the policy at base names, and for nothing else.
 */

import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadRunnerKey } from "./dsse";
import { missingCheckEvidence, readCheckEvidence } from "./check-evidence";
import { acceptedLocalEvidence, localKeyEvidenceSigner, recordLocalChecks, signLocalChecks } from "./local-evidence";
import { readTrustPolicy, trustConfigSchema } from "./policy";
import { gitRevisionSource } from "../record-source";
import { decideRefUpdate } from "./ref-gate";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function pemKey(): string {
  return generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString();
}

const pub = (pem: string) => loadRunnerKey(pem).publicKey;

function repo(trust: Record<string, unknown>): { cwd: string; base: string } {
  const cwd = mkdtempSync(join(tmpdir(), "chant-4868-"));
  git(cwd, "init", "--quiet");
  mkdirSync(join(cwd, ".chant"));
  writeFileSync(join(cwd, ".chant/trust.json"), JSON.stringify({ schema: 1, ...trust }));
  git(cwd, "add", ".");
  git(cwd, "commit", "--quiet", "-m", "base");
  return { cwd, base: git(cwd, "rev-parse", "HEAD") };
}

async function sign(cwd: string, base: string, pem: string, checks: string[]): Promise<void> {
  await recordLocalChecks(cwd, signLocalChecks(cwd, "HEAD", checks.map((check) => ({ check })), localKeyEvidenceSigner(cwd, base, pem)), { push: false });
}

describe("local evidence (#4868)", () => {
  test("a check the policy names is accepted for the tree it was signed over, and not after the tree changes", async () => {
    const alice = pemKey();
    const { cwd, base } = repo({ local: { keys: [{ principal: "alice", class: "person", key: pub(alice) }], checks: [{ check: "lint" }] } });
    await sign(cwd, base, alice, ["lint", "unit"]);
    const now = acceptedLocalEvidence(cwd, "HEAD", base, ["lint", "unit"]);
    expect(now.map((v) => v.status)).toEqual(["accepted", "not-accepted"]);
    writeFileSync(join(cwd, "x.ts"), "x\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "--quiet", "-m", "change the tree");
    expect(acceptedLocalEvidence(cwd, "HEAD", base, ["lint"])[0]!.status).toBe("missing");
  });

  test("no check takes local evidence by default", async () => {
    const alice = pemKey();
    const { cwd, base } = repo({ local: { keys: [{ principal: "alice", class: "person", key: pub(alice) }] } });
    await sign(cwd, base, alice, ["lint"]);
    expect(acceptedLocalEvidence(cwd, "HEAD", base, ["lint"])[0]!.status).toBe("not-accepted");
  });

  test("a key the change adds itself does not count until it is merged", async () => {
    const { cwd, base } = repo({ local: { checks: [{ check: "lint" }] } });
    const mallory = pemKey();
    writeFileSync(join(cwd, ".chant/trust.json"), JSON.stringify({ schema: 1, local: { keys: [{ principal: "mallory", class: "person", key: pub(mallory) }], checks: [{ check: "lint" }] } }));
    git(cwd, "commit", "--quiet", "-am", "add my key");
    const head = git(cwd, "rev-parse", "HEAD");
    // Signing against the base refuses, and evidence signed against the change's own policy is untrusted at base.
    expect(() => localKeyEvidenceSigner(cwd, base, mallory)).toThrow(/lists no local key/);
    await sign(cwd, head, mallory, ["lint"]);
    const v = acceptedLocalEvidence(cwd, "HEAD", base, ["lint"])[0]!;
    expect(v.status).toBe("untrusted");
    expect(acceptedLocalEvidence(cwd, "HEAD", head, ["lint"])[0]!.status).toBe("accepted");
  });

  test("an agent's key where the policy takes people only is not accepted", async () => {
    const agent = pemKey();
    const alice = pemKey();
    const { cwd, base } = repo({
      local: {
        keys: [{ principal: "alice", class: "person", key: pub(alice) }, { principal: "agent:session-1", class: "agent", key: pub(agent) }],
        checks: [{ check: "lint" }, { check: "fmt", from: ["person", "agent"] }],
      },
    });
    await sign(cwd, base, agent, ["lint", "fmt"]);
    const [lint, fmt] = acceptedLocalEvidence(cwd, "HEAD", base, ["lint", "fmt"]);
    expect(lint!.status).toBe("untrusted");
    expect(lint!.status === "untrusted" && lint!.reason).toMatch(/from agent agent:session-1, and the policy .* takes it from person only/);
    expect(fmt).toMatchObject({ status: "accepted", signer: "agent:session-1", class: "agent" });
  });

  test("a check that gates an apply or a release can't take local evidence", () => {
    for (const check of ["plan", "policy", "apply", "drift", "release", "gate", "plan:wave-1", "policy:wave-1"]) {
      expect(trustConfigSchema.safeParse({ schema: 1, local: { checks: [{ check }] } }).success).toBe(false);
    }
    expect(trustConfigSchema.safeParse({ schema: 1, local: { checks: [{ check: "planner-lint" }] } }).success).toBe(true);
  });

  test("a policy that names plan accepts nothing, and the plan runs", async () => {
    const alice = pemKey();
    const { cwd, base } = repo({ local: { keys: [{ principal: "alice", class: "person", key: pub(alice) }], checks: [{ check: "plan" }, { check: "lint" }] } });
    expect(readTrustPolicy(gitRevisionSource(cwd, base), base).problems.length).toBeGreaterThan(0);
    expect(acceptedLocalEvidence(cwd, "HEAD", base, ["plan", "lint"]).map((v) => v.status)).toEqual(["refused", "refused"]);
  });

  test("local evidence never counts as runner evidence, for the ref gate or an apply's evidence.requires", async () => {
    const alice = pemKey();
    const { cwd, base } = repo({
      local: { keys: [{ principal: "alice", class: "person", key: pub(alice) }], checks: [{ check: "lint" }] },
      refs: [{ ref: "refs/heads/main", checks: [{ check: "lint", command: "chant ci check" }] }],
    });
    await sign(cwd, base, alice, ["lint"]);
    expect((await readCheckEvidence(cwd, "HEAD", base, ["lint"]))[0]!.status).toBe("missing");
    expect(await missingCheckEvidence(cwd, "HEAD", base, ["lint"])).toMatch(/lacks the evidence/);
    const decided = decideRefUpdate({ repo: cwd, base, update: { ref: "refs/heads/main", old: base, new: base } });
    expect(decided.checks.map((c) => c.status)).toEqual(["missing"]);
  });

  test("a runner's key can't sign local evidence, and a key listed as both is left out", () => {
    const ci = pemKey();
    const { cwd, base } = repo({ runners: [{ principal: "ci", class: "runner", key: pub(ci) }], local: { keys: [{ principal: "ci-too", class: "person", key: pub(ci) }], checks: [{ check: "lint" }] } });
    expect(() => localKeyEvidenceSigner(cwd, base, ci)).toThrow(/runner's key/);
    expect(readTrustPolicy(gitRevisionSource(cwd, base), base).local?.excluded.map((e) => e.principal)).toEqual(["ci-too"]);
  });
});
