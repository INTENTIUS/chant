/**
 * #2553: DSSE runner evidence over record hashes, verified offline against
 * runner keys read at base. The attacker controls the change: a person's key
 * posing as a runner, a runner key the change adds, a tampered payload, a
 * swapped payload type, one runner speaking for another, and records edited
 * after the evidence was signed.
 */

import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import { canonicalJson } from "../../effect-receipt";
import { loadRunnerKey, pae, signEnvelope, sshFingerprint, ed25519FromSsh, sshFromEd25519, verifyEnvelope, IN_TOTO_PAYLOAD_TYPE } from "./dsse";
import { signRecordsEvidence } from "./evidence-cli";
import { verifyEvidence } from "./evidence";
import { policyAtBase, resolveBase } from "./provenance";
import { hasSshKeygen, note, TestRepo, writeRecordKind, writeRotation } from "./test-repo";

const repos: TestRepo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.cleanup();
});

function runnerKey(): { pem: string; pub: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  return { pem, pub: loadRunnerKey(pem).publicKey };
}

describe("DSSE", () => {
  test("PAE matches the DSSE v1 test vector", () => {
    expect(pae("http://example.com/HelloWorld", Buffer.from("hello world")).toString()).toBe("DSSEv1 29 http://example.com/HelloWorld 11 hello world");
  });

  test.skipIf(!hasSshKeygen)("ssh-ed25519 keys round-trip, and fingerprints match ssh-keygen", () => {
    const r = new TestRepo("keys");
    repos.push(r);
    const k = r.key("k");
    expect(sshFromEd25519(ed25519FromSsh(k.pub))).toBe(k.pub);
    const lf = execFileSync("ssh-keygen", ["-l", "-E", "sha256", "-f", `${k.file}.pub`], { encoding: "utf-8" }).split(" ")[1];
    expect(sshFingerprint(k.pub)).toBe(lf);
  });

  test("a signature covers the payload type as well as the payload", () => {
    const k = runnerKey();
    const { key } = loadRunnerKey(k.pem);
    const env = signEnvelope(IN_TOTO_PAYLOAD_TYPE, Buffer.from("{}"), key, k.pub);
    const trusted = [{ principal: "ci", key: k.pub }];
    expect(verifyEnvelope(env, trusted).ok).toBe(true);
    expect(verifyEnvelope({ ...env, payloadType: "text/plain" }, trusted).ok).toBe(false);
    expect(verifyEnvelope({ ...env, payload: Buffer.from("{ }").toString("base64") }, trusted).ok).toBe(false);
    expect(verifyEnvelope(env, [{ principal: "ci", key: runnerKey().pub }]).ok).toBe(false);
    expect(verifyEnvelope({ payload: "x" }, trusted).ok).toBe(false);
  });
});

describe.skipIf(!hasSshKeygen)("runner evidence", () => {
  /** main: alice signs; `ci` is a runner key in trust.json; two records. */
  function setup(label: string) {
    const r = new TestRepo(label);
    repos.push(r);
    const alice = r.key("alice");
    const ci = runnerKey();
    const kind = writeRecordKind(r);
    r.write(".chant/allowed_signers", `alice@example.test ${alice.pub}\n`);
    r.write(".chant/trust.json", JSON.stringify({ schema: 1, runners: [{ principal: "ci@example.test", class: "runner", key: ci.pub }] }));
    r.commit("policy", alice);
    r.write("records/n1.md", note("n1"));
    r.write("records/n2.md", note("n2"));
    r.commit("records", alice);
    return { r, alice, ci, kind };
  }

  function runners(r: TestRepo) {
    return policyAtBase(r.dir, resolveBase(r.dir, "main")).runners;
  }

  async function sign(r: TestRepo, kind: string, pem: string) {
    return signRecordsEvidence({ repo: r.dir, kind, cwd: r.dir, keyPem: pem, checkId: "schema-lint", base: "main", environment: Buffer.from("node 22") });
  }

  test("evidence signed by a runner verifies offline, and goes stale when a record changes", async () => {
    const { r, ci, kind, alice } = setup("good");
    const s = await sign(r, kind, ci.pem);
    if ("error" in s) throw new Error(s.error);
    expect(s.statement.subject.map((x) => x.name)).toEqual(["records/n1.md", "records/n2.md"]);
    expect(s.statement.predicate).toMatchObject({ runner: "ci@example.test", check: "schema-lint", environment: { sha256: expect.any(String) } });

    let v = verifyEvidence(s.envelope, runners(r), r.dir, r.head());
    expect(v).toMatchObject({ ok: true, status: "current", runner: "ci@example.test", class: "runner" });

    r.write("records/n2.md", note("n2", "edited"));
    r.commit("edit n2", alice);
    v = verifyEvidence(s.envelope, runners(r), r.dir, r.head());
    expect(v.ok && v.status).toBe("stale");
    expect(v.ok && v.subjects.filter((x) => !x.matches).map((x) => x.name)).toEqual(["records/n2.md"]);
  });

  test("attack: a person's key cannot sign runner evidence, or be listed as a runner", async () => {
    const { r, kind, alice } = setup("person");
    // A developer's own ssh key is not a runner key.
    const own = await sign(r, kind, readFileSync(alice.file, "utf-8"));
    expect("error" in own).toBe(true);
    // A developer who converts their ed25519 key to PEM is refused by name.
    const { privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    r.write(".chant/allowed_signers", `alice@example.test ${alice.pub}\ndev@example.test ${loadRunnerKey(pem).publicKey}\n`);
    writeRotation(r, { previousText: `alice@example.test ${alice.pub}\n`, version: 2, by: [["alice@example.test", alice]] });
    r.write(".chant/trust.json", JSON.stringify({ schema: 1, runners: [{ principal: "ci@example.test", class: "runner", key: loadRunnerKey(pem).publicKey }] }));
    r.commit("dev key in both places", alice);
    const dev = await sign(r, kind, pem);
    expect("error" in dev && dev.error).toMatch(/signer's key/);
    // Listing alice's key as a runner at base is refused when the policy is read.
    r.write(".chant/trust.json", JSON.stringify({ schema: 1, runners: [{ principal: "laptop", class: "runner", key: alice.pub }] }));
    r.commit("alice as a runner", alice);
    const policy = policyAtBase(r.dir, resolveBase(r.dir, "main"));
    expect(policy.runners).toEqual([]);
    expect(policy.excludedRunners[0].reason).toMatch(/never to a signer/);
    // A runner entry under a signer's principal is refused as well.
    r.write(".chant/trust.json", JSON.stringify({ schema: 1, runners: [{ principal: "alice@example.test", class: "service", key: runnerKey().pub }] }));
    r.commit("alice's name on a runner key", alice);
    expect(policyAtBase(r.dir, resolveBase(r.dir, "main")).runners).toEqual([]);
  });

  test("attack: a runner key the change adds is not trusted until merged", async () => {
    const { r, kind, alice } = setup("added");
    r.git(["checkout", "-q", "-b", "change"]);
    const rogue = runnerKey();
    r.write(".chant/trust.json", JSON.stringify({ schema: 1, runners: [{ principal: "rogue", class: "runner", key: rogue.pub }] }));
    r.commit("add a runner", alice);
    const s = await sign(r, kind, rogue.pem);
    expect("error" in s && s.error).toMatch(/lists no runner with this key/);
    // Hand-made evidence with that key fails too.
    const { key } = loadRunnerKey(rogue.pem);
    const env = signEnvelope(IN_TOTO_PAYLOAD_TYPE, Buffer.from("{}"), key, rogue.pub);
    expect(verifyEvidence(env, runners(r), r.dir, r.head()).ok).toBe(false);
  });

  test("attack: one runner cannot put another runner's name in the statement", async () => {
    const { r, ci, kind } = setup("impersonate");
    const s = await sign(r, kind, ci.pem);
    if ("error" in s) throw new Error(s.error);
    const forged = { ...s.statement, predicate: { ...s.statement.predicate, runner: "release@example.test" } };
    const { key } = loadRunnerKey(ci.pem);
    const env = signEnvelope(IN_TOTO_PAYLOAD_TYPE, Buffer.from(canonicalJson(forged)), key, ci.pub);
    const v = verifyEvidence(env, runners(r), r.dir, r.head());
    expect(v.ok).toBe(false);
    expect(!v.ok && v.reason).toMatch(/names runner/);
  });

  test("attack: a payload edited after signing does not verify", async () => {
    const { r, ci, kind } = setup("tamper");
    const s = await sign(r, kind, ci.pem);
    if ("error" in s) throw new Error(s.error);
    const statement = JSON.parse(Buffer.from(s.envelope.payload, "base64").toString());
    statement.subject[0].digest.sha256 = "0".repeat(64);
    const env = { ...s.envelope, payload: Buffer.from(JSON.stringify(statement)).toString("base64") };
    expect(verifyEvidence(env, runners(r), r.dir, r.head()).ok).toBe(false);
  });

  test("a removed runner key no longer verifies evidence it signed", async () => {
    const { r, ci, kind, alice } = setup("revoked");
    const s = await sign(r, kind, ci.pem);
    if ("error" in s) throw new Error(s.error);
    r.write(".chant/trust.json", JSON.stringify({ schema: 1 }));
    r.commit("retire the runner", alice);
    expect(verifyEvidence(s.envelope, runners(r), r.dir, r.head()).ok).toBe(false);
  });
});
