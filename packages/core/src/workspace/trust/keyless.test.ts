/**
 * #4869: runner statements signed keyless from the CI job's OIDC identity.
 * A fake forge token, a fake certificate authority and a fake timestamp
 * authority (./keyless-fixture.ts); nothing reaches sigstore or a forge.
 *
 * Done when: a green tag, an Op run and a piece of runner evidence signed
 * by a listed workflow identity verify offline, and one signed by another
 * workflow is reported and ignored; verification works after the
 * certificate expired; key-signed statements from before `keyless.since`
 * still count.
 */

import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { canonicalJson } from "../../effect-receipt";
import { gitRevisionSource } from "../record-source";
import { keylessEvidenceSigner, readCheckEvidence, recordChecks, runnerEvidenceSigner, runnerKeyEvidenceSigner, signChecks, type EvidenceSigner } from "./check-evidence";
import { buildCiTagStatement, verifyCiTagStatement, type CiTagRecord } from "./ci-tag-statement";
import { IN_TOTO_PAYLOAD_TYPE, loadRunnerKey } from "./dsse";
import { githubClaims, sigstoreFake, FAKE_FULCIO_URL, FAKE_GITHUB_ISSUER, FAKE_TSA_URL, type SigstoreFake } from "./keyless-fixture";
import { subjectPattern } from "./keyless";
import { buildOpRunStatement, verifyOpRunStatement } from "./op-run-statement";
import { protectedPaths, readTrustPolicy, runnersAt } from "./policy";
import type { OpRunRecord } from "../../op/runtime";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const REPO = "acme/infra";
const LISTED = `https://github.com/${REPO}/.github/workflows/chant-*.yml@refs/heads/main`;

function runnerKey(): { pem: string; pub: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  return { pem, pub: loadRunnerKey(pem).publicKey };
}

/** A repository whose base lists `ci` keyless (and, with `key`, by a runner key too), and a change on top. */
function repo(fake: SigstoreFake, opts: { key?: string; since?: (dir: string) => string } = {}): { dir: string; base: string; head: string } {
  const dir = mkdtempSync(join(tmpdir(), "chant-4869-"));
  git(dir, "init", "--quiet");
  mkdirSync(join(dir, ".chant"));
  writeFileSync(join(dir, "main.tf"), "# one\n");
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", "one");
  const trust = (since?: string) =>
    JSON.stringify({
      schema: 1,
      roles: { runner: ["ci"] },
      ...(opts.key ? { runners: [{ principal: "ci", class: "runner", key: opts.key }] } : {}),
      keyless: {
        trustedRoot: ".chant/trusted_root.json",
        fulcio: FAKE_FULCIO_URL,
        timestamp: FAKE_TSA_URL,
        identities: [{ principal: "ci", class: "runner", issuer: FAKE_GITHUB_ISSUER, subject: LISTED }],
        ...(since ? { since } : {}),
      },
    });
  writeFileSync(join(dir, ".chant/trusted_root.json"), fake.trustedRoot);
  writeFileSync(join(dir, ".chant/trust.json"), trust());
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", "trust");
  if (opts.since) {
    writeFileSync(join(dir, ".chant/trust.json"), trust(opts.since(dir)));
    git(dir, "commit", "--quiet", "-am", "since");
  }
  const base = git(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, "main.tf"), "# change\n");
  git(dir, "commit", "--quiet", "-am", "change");
  return { dir, base, head: git(dir, "rev-parse", "HEAD") };
}

const listedJob = (fake: SigstoreFake) => fake.jobEnv(githubClaims(REPO, "chant-pr.yml", "refs/heads/main"));
const otherJob = (fake: SigstoreFake) => fake.jobEnv(githubClaims(REPO, "deploy.yml", "refs/heads/main"));

/** A signer for another workflow's job: it gets a certificate, which the policy does not list, so it signs as `ci` regardless. */
async function rogueSigner(fake: SigstoreFake, r: { dir: string; base: string }): Promise<EvidenceSigner> {
  const listed = await keylessEvidenceSigner(r.dir, r.base, { env: listedJob(fake), fetch: fake.fetch });
  const { requestCertificate, keylessSignature, signingToken } = await import("./keyless");
  const { pae } = await import("./dsse");
  const cert = await requestCertificate(await signingToken(otherJob(fake), "sigstore", fake.fetch), FAKE_FULCIO_URL, fake.fetch);
  return {
    principal: listed.principal,
    sign: async (payloadType, payload) => ({ payloadType, payload: payload.toString("base64"), signatures: [await keylessSignature(pae(payloadType, payload), cert, FAKE_TSA_URL, fake.fetch)] }),
  };
}

describe("keyless runner statements (#4869)", () => {
  test("runner evidence signed by a listed workflow identity verifies offline; another workflow's is reported and ignored", async () => {
    const fake = sigstoreFake();
    const r = repo(fake);
    const signer = await keylessEvidenceSigner(r.dir, r.base, { env: listedJob(fake), fetch: fake.fetch });
    expect(signer.principal).toBe("ci");
    expect(fake.log.tokens).toEqual(["sigstore"]);
    await recordChecks(r.dir, await signChecks(r.dir, r.head, [{ check: "plan" }], signer), { push: false });
    expect(await readCheckEvidence(r.dir, r.head, r.base, ["plan"])).toEqual([{ check: "plan", status: "current", runner: "ci", commit: r.head }]);

    // Another workflow of the same repository: its own certificate, which the policy does not list.
    const rogue = await rogueSigner(fake, r);
    await recordChecks(r.dir, await signChecks(r.dir, r.head, [{ check: "policy" }], rogue), { push: false });
    const [v] = await readCheckEvidence(r.dir, r.head, r.base, ["policy"]);
    expect(v!.status).toBe("untrusted");
    expect(v).toMatchObject({ reason: expect.stringContaining(`https://github.com/${REPO}/.github/workflows/deploy.yml@refs/heads/main`) });
    expect(v).toMatchObject({ reason: expect.stringContaining("not one the policy at base lists under keyless.identities") });
  });

  test("the signer refuses a job whose identity the policy does not list, before it signs anything", async () => {
    const fake = sigstoreFake();
    const r = repo(fake);
    await expect(keylessEvidenceSigner(r.dir, r.base, { env: otherJob(fake), fetch: fake.fetch })).rejects.toThrow(/lists no keyless identity for this job .*deploy\.yml/);
    expect(fake.log.timestamps).toBe(0);
    await expect(keylessEvidenceSigner(r.dir, r.base, { env: {}, fetch: fake.fetch })).rejects.toThrow(/id-token: write/);
  });

  test("a green tag and an Op run signed keyless verify offline, and another workflow's are ignored", async () => {
    const fake = sigstoreFake();
    const r = repo(fake);
    const policy = readTrustPolicy(gitRevisionSource(r.dir, r.base), r.base);
    const runners = runnersAt(policy, { repo: r.dir, commit: r.head });
    const signer = await keylessEvidenceSigner(r.dir, r.base, { env: listedJob(fake), fetch: fake.fetch });
    const rogue = await rogueSigner(fake, r);
    const sign = (s: EvidenceSigner, statement: unknown) => s.sign(IN_TOTO_PAYLOAD_TYPE, Buffer.from(canonicalJson(statement), "utf8"));

    const tag: CiTagRecord = { schema: 1, tag: "green", commit: r.head, branch: "main", at: "2026-11-09T00:00:00Z" };
    const signedTag = { ...tag, statement: await sign(signer, buildCiTagStatement(tag, "ci")) };
    expect(verifyCiTagStatement(signedTag, { sha: r.head, kind: "green", branch: "main" }, runners, policy.roles)).toMatchObject({ status: "signed", signer: "ci" });
    const rogueTag = { ...tag, statement: await sign(rogue, buildCiTagStatement(tag, "ci")) };
    expect(verifyCiTagStatement(rogueTag, { sha: r.head, kind: "green", branch: "main" }, runners, policy.roles)).toMatchObject({ status: "untrusted", reason: expect.stringContaining("deploy.yml") });

    const run = { id: "run-1", op: "apply", env: "prod", status: "ok", gitSha: r.head } as unknown as OpRunRecord;
    const signedRun = { ...run, statement: await sign(signer, buildOpRunStatement(run, "ci")) } as OpRunRecord;
    expect(verifyOpRunStatement(signedRun, runners, policy.roles)).toMatchObject({ status: "signed", signer: "ci" });
    const rogueRun = { ...run, statement: await sign(rogue, buildOpRunStatement(run, "ci")) } as OpRunRecord;
    expect(verifyOpRunStatement(rogueRun, runners, policy.roles)).toMatchObject({ status: "untrusted" });
  });

  test("a statement verifies after its certificate expired: validity is judged at the timestamp's time", async () => {
    // The authorities' clock is in 2021; the certificate lived ten minutes then. Verification runs now.
    const fake = sigstoreFake({ now: new Date("2021-03-01T12:00:00Z") });
    const r = repo(fake);
    const signer = await keylessEvidenceSigner(r.dir, r.base, { env: listedJob(fake), fetch: fake.fetch });
    await recordChecks(r.dir, await signChecks(r.dir, r.head, [{ check: "plan" }], signer), { push: false });
    expect(await readCheckEvidence(r.dir, r.head, r.base, ["plan"])).toEqual([{ check: "plan", status: "current", runner: "ci", commit: r.head }]);

    // A timestamp from after the certificate expired does not count.
    const late = await keylessEvidenceSigner(r.dir, r.base, { env: listedJob(fake), fetch: fake.fetch });
    fake.setNow(new Date("2021-03-01T12:30:00Z"));
    await expect(signChecks(r.dir, r.head, [{ check: "policy" }], late)).rejects.toThrow(/does not chain to a certificate authority of the trusted root, valid at 2021-03-01T12:30/);
  });

  test("key-signed evidence before keyless.since still counts, and after it does not", async () => {
    const fake = sigstoreFake();
    const key = runnerKey();
    let first = "";
    const r = repo(fake, {
      key: key.pub,
      since: (dir) => {
        first = git(dir, "rev-parse", "HEAD~1");
        return git(dir, "rev-parse", "HEAD");
      },
    });
    const keySigner = runnerKeyEvidenceSigner(r.dir, r.base, key.pem);
    await recordChecks(r.dir, await signChecks(r.dir, first, [{ check: "plan" }], keySigner), { push: false });
    await recordChecks(r.dir, await signChecks(r.dir, r.head, [{ check: "plan" }], keySigner), { push: false });
    expect(await readCheckEvidence(r.dir, first, r.base, ["plan"])).toEqual([{ check: "plan", status: "current", runner: "ci", commit: first }]);
    expect((await readCheckEvidence(r.dir, r.head, r.base, ["plan"]))[0]!.status).toBe("untrusted");
    // The same commit signed keyless counts.
    const keyless = await runnerEvidenceSigner(r.dir, r.base, { env: { ...listedJob(fake), CHANT_RUNNER_IDENTITY: "oidc" }, fetch: fake.fetch });
    await recordChecks(r.dir, await signChecks(r.dir, r.head, [{ check: "plan" }], keyless!), { push: false });
    expect(await readCheckEvidence(r.dir, r.head, r.base, ["plan"])).toEqual([{ check: "plan", status: "current", runner: "ci", commit: r.head }]);
  });

  test("a trusted root that does not read leaves the identities out, and since still leaves the keys out", () => {
    const fake = sigstoreFake();
    const r = repo(fake, { key: runnerKey().pub, since: (dir) => git(dir, "rev-parse", "HEAD") });
    writeFileSync(join(r.dir, ".chant/trusted_root.json"), "{}");
    git(r.dir, "commit", "--quiet", "-am", "break the root");
    const at = git(r.dir, "rev-parse", "HEAD");
    const policy = readTrustPolicy(gitRevisionSource(r.dir, at), at);
    expect(policy.runnerIdentities).toEqual([]);
    expect(policy.excludedRunners[0]!.reason).toMatch(/trusted root .chant\/trusted_root.json cannot be read/);
    expect(runnersAt(policy, { repo: r.dir, commit: at })).toEqual([]);
    expect(protectedPaths(policy)).toContain(".chant/trusted_root.json");
  });

  test("a subject pattern's * stays within a path segment, ** crosses them", () => {
    expect(subjectPattern(LISTED).test(`https://github.com/${REPO}/.github/workflows/chant-pr.yml@refs/heads/main`)).toBe(true);
    expect(subjectPattern(LISTED).test(`https://github.com/${REPO}/.github/workflows/sub/chant-pr.yml@refs/heads/main`)).toBe(false);
    expect(subjectPattern("https://gitlab.com/acme/**@refs/heads/main").test("https://gitlab.com/acme/infra//.gitlab-ci.yml@refs/heads/main")).toBe(true);
  });
});

describe("the runner identity an init writes (#4869)", () => {
  test("a GitHub workflow's identity goes under keyless, and its principal under roles.runner, once", async () => {
    const { ciRunnerIdentity, withRunnerIdentity } = await import("./runner-identity");
    const id = ciRunnerIdentity({ forge: "github", repository: REPO, workflow: ".github/workflows/chant-pr.yml" });
    expect(id).toEqual({ principal: "ci", class: "runner", issuer: FAKE_GITHUB_ISSUER, subject: `https://github.com/${REPO}/.github/workflows/chant-pr.yml@refs/heads/main` });
    const once = withRunnerIdentity(JSON.stringify({ schema: 1, roles: { admin: ["alice"] } }), id);
    expect(withRunnerIdentity(once, id)).toBe(once);
    expect(JSON.parse(once)).toEqual({ schema: 1, roles: { admin: ["alice"], runner: ["ci"] }, keyless: { trustedRoot: ".chant/trusted_root.json", identities: [id] } });
    expect(ciRunnerIdentity({ forge: "gitlab", repository: "acme/infra" }).subject).toBe("https://gitlab.com/acme/infra//.gitlab-ci.yml@refs/heads/main");
    expect(() => ciRunnerIdentity({ forge: "forgejo", repository: "acme/infra", workflow: "x.yml" })).toThrow(/certificate authority the project runs/);
  });
});

describe("DER INTEGERs (#4869)", () => {
  test("a serial with leading zero bytes is written in minimal form, so OpenSSL reads the certificate", async () => {
    const { derInt } = await import("./keyless");
    expect(derInt(Buffer.from("003a2d0f26856400", "hex")).toString("hex")).toBe("02073a2d0f26856400");
    expect(derInt(Buffer.from("0000ff", "hex")).toString("hex")).toBe("020200ff");
    expect(derInt(Buffer.from("80", "hex")).toString("hex")).toBe("02020080");
    expect(derInt(Buffer.from("0000", "hex")).toString("hex")).toBe("020100");
    expect(derInt(3).toString("hex")).toBe("020103");
  });
});
