/**
 * #5470: runner keys may be ECDSA P-256 as well as Ed25519. Runner evidence,
 * runner-start statements and ci tag statements sign and verify with either,
 * an Ed25519 key made before still works, and the trust config lists a P-256
 * key as an `ecdsa-sha2-nistp256` line.
 */

import { execFileSync } from "node:child_process";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { signRunnerStart, verifyRunnerStart, type CiJobIdentity } from "../../runner-start";
import { signCiTagRecord, verifyCiTagStatement } from "./ci-tag-statement";
import { IN_TOTO_PAYLOAD_TYPE, loadRunnerKey, p256FromSsh, runnerKeyKindOf, signEnvelope, sshFingerprint, sshFromP256, verifyEnvelope } from "./dsse";
import { verifyEvidence } from "./evidence";
import { signRecordsEvidence } from "./evidence-cli";
import { trustConfigSchema } from "./policy";
import { policyAtBase, resolveBase } from "./provenance";
import { hasSshKeygen, note, TestRepo, writeRecordKind } from "./test-repo";
import { trustConfigProblems } from "./trust-files";
import { runnerPublicKey } from "./trust-write";

const repos: TestRepo[] = [];
const dirs: string[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.cleanup();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function pemKey(kind: "ed25519" | "p256" | "p384", type: "pkcs8" | "sec1" = "pkcs8"): { pem: string; pub: string } {
  const { privateKey } = kind === "ed25519" ? generateKeyPairSync("ed25519") : generateKeyPairSync("ec", { namedCurve: kind === "p256" ? "P-256" : "P-384" });
  const pem = privateKey.export({ format: "pem", type }).toString();
  return { pem, pub: kind === "p384" ? "" : loadRunnerKey(pem).publicKey };
}

describe("ECDSA P-256 runner keys in DSSE", () => {
  test("a P-256 key in PKCS#8 or SEC1 PEM loads as an ecdsa-sha2-nistp256 line, and its point round-trips", () => {
    for (const type of ["pkcs8", "sec1"] as const) {
      const k = pemKey("p256", type);
      const loaded = loadRunnerKey(k.pem);
      expect(loaded.kind).toBe("ecdsa-p256");
      expect(loaded.publicKey).toMatch(/^ecdsa-sha2-nistp256 [A-Za-z0-9+/]+=*$/);
      expect(runnerKeyKindOf(loaded.publicKey)).toBe("ecdsa-p256");
      expect(sshFromP256(p256FromSsh(loaded.publicKey))).toBe(loaded.publicKey);
    }
    expect(loadRunnerKey(pemKey("ed25519").pem).kind).toBe("ed25519");
  });

  test("a P-384 key, or an RSA key, is not a runner key", () => {
    expect(() => loadRunnerKey(pemKey("p384").pem)).toThrow(/P-256, not P-384/);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    expect(() => loadRunnerKey(rsa)).toThrow(/Ed25519 or ECDSA P-256, not rsa/);
  });

  test("an envelope signed with a P-256 key verifies against its line, and against no other key", () => {
    const k = pemKey("p256");
    const { key } = loadRunnerKey(k.pem);
    const env = signEnvelope(IN_TOTO_PAYLOAD_TYPE, Buffer.from("{}"), key, k.pub);
    expect(env.signatures[0]!.keyid).toBe(sshFingerprint(k.pub));
    // ECDSA with SHA-256, DER-encoded: a SEQUENCE.
    expect(Buffer.from(env.signatures[0]!.sig, "base64")[0]).toBe(0x30);
    const trusted = [{ principal: "ci", key: k.pub }];
    expect(verifyEnvelope(env, trusted)).toMatchObject({ ok: true, principal: "ci" });
    expect(verifyEnvelope({ ...env, payloadType: "text/plain" }, trusted).ok).toBe(false);
    expect(verifyEnvelope(env, [{ principal: "ci", key: pemKey("p256").pub }]).ok).toBe(false);
    // An Ed25519 key with the P-256 key's id, or the other way round, verifies nothing.
    const ed = pemKey("ed25519");
    const edEnv = signEnvelope(IN_TOTO_PAYLOAD_TYPE, Buffer.from("{}"), loadRunnerKey(ed.pem).key, ed.pub);
    expect(verifyEnvelope({ ...edEnv, signatures: [{ ...edEnv.signatures[0]!, keyid: sshFingerprint(k.pub) }] }, trusted).ok).toBe(false);
    expect(verifyEnvelope(edEnv, [{ principal: "old", key: ed.pub }, ...trusted])).toMatchObject({ ok: true, principal: "old" });
  });

  test.skipIf(!hasSshKeygen)("the line and fingerprint are the ones ssh-keygen prints for the same key", () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-p256-"));
    dirs.push(dir);
    const k = pemKey("p256");
    const pubPem = join(dir, "k.pub.pem");
    writeFileSync(pubPem, createPublicKey(k.pem).export({ format: "pem", type: "spki" }));
    const line = execFileSync("ssh-keygen", ["-i", "-m", "PKCS8", "-f", pubPem], { encoding: "utf-8" }).trim();
    expect(line).toBe(k.pub);
    writeFileSync(join(dir, "k.pub"), `${line}\n`);
    const lf = execFileSync("ssh-keygen", ["-l", "-E", "sha256", "-f", join(dir, "k.pub")], { encoding: "utf-8" }).split(" ")[1];
    expect(sshFingerprint(k.pub)).toBe(lf);
  });
});

describe("the trust config lists P-256 runner keys", () => {
  test("the zod schema and the plain reader accept an ecdsa-sha2-nistp256 runner or local key, and refuse P-384", () => {
    const p256 = pemKey("p256").pub;
    const ok = { schema: 1, runners: [{ principal: "ci", class: "runner", key: p256 }], local: { keys: [{ principal: "dev", class: "person", key: p256 }], checks: [{ check: "lint" }] } };
    expect(trustConfigSchema.safeParse(ok).success).toBe(true);
    expect(trustConfigProblems(ok)).toEqual([]);
    const p384 = { schema: 1, runners: [{ principal: "ci", class: "runner", key: `ecdsa-sha2-nistp384 ${Buffer.from("x").toString("base64")}` }] };
    expect(trustConfigSchema.safeParse(p384).success).toBe(false);
    expect(trustConfigProblems(p384)).toHaveLength(1);
  });

  test("trust runner add takes a P-256 line or PEM, and refuses a line whose blob is not P-256", () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-p256-add-"));
    dirs.push(dir);
    const k = pemKey("p256");
    writeFileSync(join(dir, "runner.pem"), k.pem);
    expect(runnerPublicKey("runner.pem", dir)).toBe(k.pub);
    expect(runnerPublicKey(`${k.pub} host@ci`, dir)).toBe(k.pub);
    const ed = pemKey("ed25519");
    expect(() => runnerPublicKey(`ecdsa-sha2-nistp256 ${ed.pub.split(" ")[1]}`, dir)).toThrow(/not an ecdsa-sha2-nistp256 public key/);
    expect(() => runnerPublicKey(`ecdsa-sha2-nistp384 AAAA`, dir)).toThrow(/ssh-ed25519 or ecdsa-sha2-nistp256/);
  });
});

const SHA = "a".repeat(40);
const JOB: CiJobIdentity = { system: "github", repo: "acme/infra", run: "4242", attempt: "1", job: "apply", commit: SHA, runner: "jit-4242" };

describe("runner-start statements and ci tags with either kind", () => {
  for (const kind of ["p256", "ed25519"] as const) {
    test(`a ${kind} provisioner's runner-start statement verifies`, () => {
      const k = pemKey(kind);
      const loaded = loadRunnerKey(k.pem);
      const envelope = signRunnerStart(JOB, { principal: "provisioner", key: loaded.key, publicKey: loaded.publicKey }, new Date("2026-11-21T12:00:00Z"));
      const v = verifyRunnerStart({ envelope, job: JOB, runners: [{ principal: "provisioner", key: k.pub }], roles: { runner: ["provisioner"] } });
      expect(v).toMatchObject({ status: "verified", signer: "provisioner" });
    });

    test(`a ${kind} runner's ci tag statement verifies`, () => {
      const k = pemKey(kind);
      const loaded = loadRunnerKey(k.pem);
      const record = { schema: 1, tag: "green" as const, commit: SHA, branch: "main", at: "2026-11-21T12:00:00Z" };
      const statement = signCiTagRecord(record, { principal: "bot", key: loaded.key, publicKey: loaded.publicKey });
      const v = verifyCiTagStatement({ ...record, statement }, { sha: SHA, kind: "green", branch: "main" }, [{ principal: "bot", class: "runner", key: k.pub }], { runner: ["bot"] });
      expect(v).toMatchObject({ status: "signed", signer: "bot", keyid: sshFingerprint(k.pub) });
    });
  }
});

describe.skipIf(!hasSshKeygen)("runner evidence with a P-256 key", () => {
  test("evidence a P-256 runner signs verifies offline beside an Ed25519 runner's", async () => {
    const r = new TestRepo("p256-evidence");
    repos.push(r);
    const alice = r.key("alice");
    const p256 = pemKey("p256");
    const ed = pemKey("ed25519");
    const kind = writeRecordKind(r);
    r.write(".chant/allowed_signers", `alice@example.test ${alice.pub}\n`);
    r.write(
      ".chant/trust.json",
      JSON.stringify({
        schema: 1,
        runners: [
          { principal: "fips@example.test", class: "runner", key: p256.pub },
          { principal: "ci@example.test", class: "runner", key: ed.pub },
        ],
      }),
    );
    r.commit("policy", alice);
    r.write("records/n1.md", note("n1"));
    r.commit("records", alice);
    const runners = policyAtBase(r.dir, resolveBase(r.dir, "main")).runners;
    expect(runners.map((x) => x.principal).sort()).toEqual(["ci@example.test", "fips@example.test"]);
    for (const [k, who] of [[p256, "fips@example.test"], [ed, "ci@example.test"]] as const) {
      const s = await signRecordsEvidence({ repo: r.dir, kind, cwd: r.dir, keyPem: k.pem, checkId: "schema-lint", base: "main" });
      if ("error" in s) throw new Error(s.error.message);
      expect(verifyEvidence(s.envelope, runners, r.dir, r.head())).toMatchObject({ ok: true, status: "current", runner: who });
    }
    expect(readFileSync(join(r.dir, ".chant/trust.json"), "utf-8")).toContain("ecdsa-sha2-nistp256 ");
  });
});
