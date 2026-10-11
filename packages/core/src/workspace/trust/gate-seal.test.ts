/**
 * #3763: a gate approval's seal, checked with node:crypto, answers as
 * ssh-keygen does. Each seal is made by `ssh-keygen -Y sign` and checked both
 * ways: {@link gateSealRefusal} here, and `checkGateSeal` (ssh-keygen) in
 * `./seal.ts`.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { GATE_SEAL_NAMESPACE, gateSealPayload, gateSealRefusal, sshKeyFingerprint, verifySshSignatureWith, type GateSigners, type SealedGateApproval } from "./gate-seal";
import { checkGateSeal } from "./seal";
import { emptyPolicy, parseAllowedSigners, type TrustPolicy } from "./policy";
import { hasSshKeygen } from "./test-repo";

const dir = mkdtempSync(join(tmpdir(), "chant-3763-seal-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Key {
  file: string;
  /** `<type> <base64>`. */
  pub: string;
}

function key(name: string, args: string[]): Key {
  const file = join(dir, `key-${name}`);
  execFileSync("ssh-keygen", ["-q", ...args, "-N", "", "-C", name, "-f", file]);
  return { file, pub: readFileSync(`${file}.pub`, "utf-8").trim().split(" ").slice(0, 2).join(" ") };
}

function sign(k: Key, payload: Buffer, namespace = GATE_SEAL_NAMESPACE): string {
  const f = join(dir, `payload-${Math.random().toString(36).slice(2)}`);
  writeFileSync(f, payload);
  execFileSync("ssh-keygen", ["-q", "-Y", "sign", "-n", namespace, "-f", k.file, f], { stdio: "ignore" });
  return readFileSync(`${f}.sig`, "utf-8");
}

const blob = (k: Key): Buffer => Buffer.from(k.pub.split(" ")[1]!, "base64");

function approval(over: Partial<SealedGateApproval> = {}): SealedGateApproval {
  return { op: "migrations", gate: "migrations-wave-1", planDigest: "jcs1-sha256:abc", resolvedBy: "alice", timestamp: "2026-10-11T00:00:00.000Z", ...over };
}

function policyOf(text: string): TrustPolicy {
  const set = parseAllowedSigners(text);
  return { ...emptyPolicy("0".repeat(40)), active: true, signers: set.signers, excluded: set.excluded };
}

/** Both checks, as `{ ours, keygen }`: null or the refusal, and whether ssh-keygen attested it. */
function both(policy: TrustPolicy, a: SealedGateApproval): { ours: string | null; keygen: boolean } {
  return { ours: gateSealRefusal(policy as GateSigners, a), keygen: checkGateSeal(policy, a).attested === true };
}

describe.skipIf(!hasSshKeygen)("an SSHSIG checked with node:crypto", () => {
  const keys: Array<[string, string[]]> = [
    ["ed25519", ["-t", "ed25519"]],
    ["rsa", ["-t", "rsa", "-b", "2048"]],
    ["ecdsa-256", ["-t", "ecdsa", "-b", "256"]],
    ["ecdsa-384", ["-t", "ecdsa", "-b", "384"]],
    ["ecdsa-521", ["-t", "ecdsa", "-b", "521"]],
  ];

  test.each(keys)("a %s seal verifies, and an edited approval does not", (name, args) => {
    const k = key(`alice-${name}`, args);
    const a = approval();
    const signature = sign(k, gateSealPayload(a));
    const r = verifySshSignatureWith(signature, gateSealPayload(a), GATE_SEAL_NAMESPACE, [blob(k)]);
    expect(r).toEqual({ ok: true, key: sshKeyFingerprint(blob(k)) });
    // The fingerprint is the one ssh-keygen prints.
    expect(execFileSync("ssh-keygen", ["-l", "-f", `${k.file}.pub`], { encoding: "utf-8" })).toContain(sshKeyFingerprint(blob(k)));

    const policy = policyOf(`alice ${k.pub}\n`);
    const seal = { signer: "alice", key: "SHA256:x", signature };
    expect(both(policy, { ...a, seal })).toEqual({ ours: null, keygen: true });
    for (const edited of [{ planDigest: "jcs1-sha256:other" }, { timestamp: "2026-10-12T00:00:00.000Z" }, { relayedBy: "bot" }, { environment: "prod" }]) {
      const res = both(policy, { ...a, ...edited, seal });
      expect(res.keygen).toBe(false);
      expect(res.ours).toMatch(/does not verify for alice/);
    }
  });

  test("a seal in another namespace, or by a key listed for someone else, does not count either way", () => {
    const alice = key("alice-ns", ["-t", "ed25519"]);
    const bob = key("bob-ns", ["-t", "ed25519"]);
    const a = approval();
    const policy = policyOf(`alice ${alice.pub}\nbob ${bob.pub}\n`);

    const otherNs = { signer: "alice", key: "k", signature: sign(alice, gateSealPayload(a), "chant-review") };
    expect(both(policy, { ...a, seal: otherNs }).keygen).toBe(false);
    expect(both(policy, { ...a, seal: otherNs }).ours).toMatch(/chant-review namespace/);

    const byBob = { signer: "alice", key: "k", signature: sign(bob, gateSealPayload(a)) };
    expect(both(policy, { ...a, seal: byBob }).keygen).toBe(false);
    expect(both(policy, { ...a, seal: byBob }).ours).toMatch(/does not list/);
  });

  test("a signers line's namespaces option is honoured", () => {
    const k = key("alice-opt", ["-t", "ed25519"]);
    const a = approval();
    const seal = { signer: "alice", key: "k", signature: sign(k, gateSealPayload(a)) };
    expect(both(policyOf(`alice namespaces="chant-gate,git" ${k.pub}\n`), { ...a, seal })).toEqual({ ours: null, keygen: true });
    expect(both(policyOf(`alice namespaces="chant-*" ${k.pub}\n`), { ...a, seal })).toEqual({ ours: null, keygen: true });
    const refused = both(policyOf(`alice namespaces="git" ${k.pub}\n`), { ...a, seal });
    expect(refused.keygen).toBe(false);
    expect(refused.ours).not.toBeNull();
  });

  test("principals compare as chant compares them", () => {
    const k = key("alice-case", ["-t", "ed25519"]);
    const a = approval({ resolvedBy: "github:Alice" });
    const seal = { signer: "github:alice", key: "k", signature: sign(k, gateSealPayload(a)) };
    expect(both(policyOf(`github:alice ${k.pub}\n`), { ...a, seal })).toEqual({ ours: null, keygen: true });
  });
});

describe("the refusals that need no signature", () => {
  const signers = (over: Partial<GateSigners> = {}): GateSigners => ({ base: "a".repeat(40), signersPath: ".chant/allowed_signers", active: true, signers: [], problems: [], ...over });

  test("no signers file at base passes nothing", () => {
    expect(gateSealRefusal(signers({ active: false }), approval())).toBe(`the gate is sealed, and there is no signers file (.chant/allowed_signers) at base ${"a".repeat(12)}`);
    expect(gateSealRefusal(signers({ active: false, problems: [".chant/trust.json is invalid"] }), approval())).toMatch(/: \.chant\/trust\.json is invalid$/);
  });

  test("an unsigned, malformed, or someone else's seal", () => {
    const listed = signers({ signers: parseAllowedSigners("alice ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOv1\n").signers });
    expect(gateSealRefusal(listed, approval())).toBe("the approval of gate migrations-wave-1 by alice carries no seal");
    expect(gateSealRefusal(listed, approval({ seal: { signer: "alice" } }))).toMatch(/malformed/);
    expect(gateSealRefusal(listed, approval({ seal: { signer: "bob", signature: "x" } }))).toMatch(/is by bob, and its approver is alice/);
    expect(gateSealRefusal(listed, approval({ resolvedBy: "carol", seal: { signer: "carol", signature: "x" } }))).toBe("carol has no key in .chant/allowed_signers at base, so the seal can't count");
    expect(gateSealRefusal(listed, approval({ seal: { signer: "alice", signature: "not a signature" } }))).toMatch(/not an armored ssh signature/);
  });
});
