/**
 * #5177: a signed cut signs the green gate its line records (`green`,
 * `override`, `lane`) with the release digest, under payload version 2. A
 * changed gate no longer verifies; a cut signed over version 1 still
 * verifies and its gate reads unsigned; `release verify` and `release
 * publish` say which. Throwaway keys in temp repos only.
 */

import { afterAll, describe, expect, test } from "vitest";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { cutRelease } from "./release-cut";
import { verifyRelease, verificationCode, type ReleaseVerification } from "./release-verify";
import { preparePublish, type PublishPlan } from "./release-publish";
import { ledgerDir, writeLedgerFiles, readPathSha } from "./git";
import { readCuts, RELEASES_DIR, type ReleaseArtifact, type ReleaseCut } from "./release-store";
import { admitReleaseCut, admitReleaseStatus, releaseGateSealPayload, releaseSealPayload, releaseStatusSealPayload, RELEASE_SEAL_NAMESPACE, type GateAdmissionRule } from "../workspace/identity-gate-rule";
import { sshKeygen } from "../workspace/trust/ssh-commit";
import { sortedJsonReplacer } from "../utils";
import type { CompiledTarget, TargetCompiler } from "../components/release-compile";
import { hasSshKeygen, TestRepo, type Key } from "../workspace/trust/test-repo";

const repos: TestRepo[] = [];
afterAll(() => {
  for (const r of repos) rmSync(dirname(r.dir), { recursive: true, force: true });
});

const compiler: TargetCompiler = {
  async compile(env): Promise<CompiledTarget> {
    return { env, params: [], components: ["api"], buildSteps: {}, buildInputs: {}, componentFiles: { api: "api.component.ts" }, templates: [{ component: "api", path: "dist/api.json", content: `{"env":"${env}"}\n` }] };
  },
  async buildArtifacts(): Promise<ReleaseArtifact[]> {
    return [];
  },
};

/** A workspace member under verified-releases whose signers file lists alice, with one green commit. */
function setup(): { r: TestRepo; alice: Key } {
  const r = new TestRepo("release-gate-seal");
  repos.push(r);
  const alice = r.key("alice");
  r.write("chant.workspace.json", JSON.stringify({ name: "acme", schema: 1, members: [{ name: "root", dir: ".", kind: "other", because: "the gate seal fixture" }], security: ["verified-releases"] }, null, 2));
  r.write(".chant/allowed_signers", `alice ${alice.pub}\n`);
  r.write("chant.config.ts", `export default { environments: ["dev"] };\n`);
  r.write("api.component.ts", "export const api = {};\n");
  const head = r.commit("init");
  r.git(["tag", `ci/green/${head}`]);
  return { r, alice };
}

const cut = (r: TestRepo, alice: Key) => cutRelease({ cwd: r.dir, compiler, label: "v1", actor: "alice", env: {}, now: () => new Date("2026-11-16T10:00:00.000Z"), sign: alice.file });

const checked = async (r: TestRepo): Promise<ReleaseVerification> => {
  const v = await verifyRelease({ cwd: r.dir, ref: "v1" });
  if ("error" in v) throw new Error(v.error.message);
  return v;
};

/** Rewrite the only cut line on `chant/lifecycle` through `change`. */
async function rewriteCut(r: TestRepo, change: (c: ReleaseCut) => ReleaseCut): Promise<void> {
  const { cuts } = await readCuts({ cwd: r.dir });
  expect(cuts).toHaveLength(1);
  const dir = await ledgerDir(RELEASES_DIR, { cwd: r.dir });
  const prior = await readPathSha(RELEASES_DIR, "cuts.jsonl", { cwd: r.dir });
  await writeLedgerFiles([{ path: `${dir}/cuts.jsonl`, content: `${JSON.stringify(change(cuts[0]!), sortedJsonReplacer)}\n`, expectPriorSha: prior }], "Rewrite cut", { cwd: r.dir });
}

function signV1(key: Key, c: ReleaseCut): string {
  const out = sshKeygen(["-q", "-Y", "sign", "-n", RELEASE_SEAL_NAMESPACE, "-f", key.file], releaseSealPayload(c));
  expect(out.status).toBe(0);
  return out.stdout;
}

describe("the cut signature covers the green gate (#5177)", () => {
  test("version 2 adds the gate record after the four lines of version 1, apart from a status change's bytes", () => {
    const c = { releaseDigest: "sha256:ab", label: "v1", actor: "alice", timestamp: "2026-11-16T10:00:00.000Z" };
    const v2 = releaseGateSealPayload({ ...c, green: { tag: "ci/green/abc", source: "chant" }, lane: "fast" }).toString();
    expect(v2).toBe(`${releaseSealPayload(c).toString()}\nseal:2\ngate:{"green":{"source":"chant","tag":"ci/green/abc"},"lane":"fast"}`);
    expect(releaseGateSealPayload(c).toString()).toBe(`${releaseSealPayload(c).toString()}\nseal:2\ngate:{}`);
    expect(v2).not.toContain("\nstatus:");
  });

  test.skipIf(!hasSshKeygen)("a signed cut signs its gate: verify reports it signed, and a changed gate or a dropped version does not verify", async () => {
    const { r, alice } = setup();
    const { cut: line } = await cut(r, alice);
    expect(line).toMatchObject({ sealVersion: 2, green: { source: "chant" } });
    const v = await checked(r);
    expect(v.status).toBe("verified");
    expect(v.gate).toEqual({ status: "signed", reason: "the green gate the cut by alice records is covered by its signature" });
    expect(v.cuts[0]!.signatureCheck.gate).toBe("signed");

    const plan = (await preparePublish({ cwd: r.dir, ref: "v1", env: { PATH: process.env.PATH } })) as PublishPlan;
    expect(plan.signature).toMatchObject({ status: "verified", gate: "signed" });
    expect(plan.gateWarning).toBeNull();
    expect(plan.cut).toMatchObject({ sealVersion: 2, gate: "signed" });

    // The gate is claimed to be the forge's checks after the cut: the signature no longer verifies.
    await rewriteCut(r, (c) => ({ ...c, green: { source: "forge-checks", forge: "github", checks: ["ci"] } }));
    const forged = await checked(r);
    expect(forged.status).toBe("unverified");
    expect(verificationCode(forged)).toBe("release-signature-unverified");
    expect(forged.gate.status).toBe("unsigned");

    // Put the gate back and drop sealVersion, to pass the line off as version 1: it does not verify either.
    await rewriteCut(r, (c) => ({ ...c, green: line!.green }));
    expect((await checked(r)).status).toBe("verified");
    await rewriteCut(r, ({ sealVersion: _v, ...c }) => c);
    expect((await checked(r)).status).toBe("unverified");
  });

  test.skipIf(!hasSshKeygen)("a cut signed over version 1 still verifies, its gate reads unsigned, and publish under verified-releases warns", async () => {
    const { r, alice } = setup();
    await cut(r, alice);
    await rewriteCut(r, ({ sealVersion: _v, ...c }) => ({ ...c, signature: signV1(alice, c) }));
    const v = await checked(r);
    expect(v.status).toBe("verified");
    expect(verificationCode(v)).toBeNull();
    expect(v.gate).toEqual({ status: "unsigned", reason: "the cut by alice was signed before chant signed the green gate, so its signature does not cover the gate the cut line records" });

    const plan = (await preparePublish({ cwd: r.dir, ref: "v1", env: { PATH: process.env.PATH } })) as PublishPlan;
    expect(plan.signature).toMatchObject({ status: "verified", gate: "unsigned" });
    expect(plan.gateWarning).toMatch(/^the cut of v1 by alice was signed before chant signed the green gate/);
    expect(plan.cut?.gate).toBe("unsigned");
    expect(plan.cut?.sealVersion).toBeUndefined();
  });

  test.skipIf(!hasSshKeygen)("a version 1 cut, a version 2 cut and a status change never verify as each other", () => {
    const r = new TestRepo("release-seal-kinds");
    repos.push(r);
    const alice = r.key("alice");
    const rule: GateAdmissionRule = { gate: "release", class: null, signers: { signersPath: ".chant/allowed_signers", active: true, signers: [{ principal: "alice", key: alice.pub, line: 1 }] }, roles: {}, classes: [] };
    const sign = (payload: Buffer): string => {
      const out = sshKeygen(["-q", "-Y", "sign", "-n", RELEASE_SEAL_NAMESPACE, "-f", alice.file], payload);
      expect(out.status).toBe(0);
      return out.stdout;
    };
    const base = { releaseDigest: "sha256:ab", label: "v1", actor: "alice", timestamp: "2026-11-16T10:00:00.000Z" };
    const gate = { green: { tag: "ci/green/abc", source: "chant" }, lane: "fast" };
    const signed = { v1: sign(releaseSealPayload(base)), v2: sign(releaseGateSealPayload({ ...base, ...gate })), status: sign(releaseStatusSealPayload({ ...base, status: "yanked" })) };
    // Each verifies as what it was signed for.
    const asV1 = (signature: string) => admitReleaseCut(rule, { ...base, signature });
    const asV2 = (signature: string) => admitReleaseCut(rule, { ...base, ...gate, sealVersion: 2, signature });
    const asStatus = (signature: string) => admitReleaseStatus(rule, { ...base, status: "yanked", signature });
    expect([asV1(signed.v1), asV2(signed.v2), asStatus(signed.status)]).toEqual([null, null, null]);
    // And as nothing else.
    for (const [kind, sig] of Object.entries(signed)) {
      if (kind !== "v1") expect(asV1(sig)).toMatch(/does not verify/);
      if (kind !== "v2") expect(asV2(sig)).toMatch(/does not verify/);
      if (kind !== "status") expect(asStatus(sig)).toMatch(/does not verify/);
    }
    // A field with a line break can't splice one kind's lines into another's:
    // the status change's bytes are those of a version 1 cut whose time ends in "\nstatus:yanked".
    const spliced = { ...base, timestamp: `${base.timestamp}\nstatus:yanked` };
    expect(releaseSealPayload(spliced).equals(releaseStatusSealPayload({ ...base, status: "yanked" }))).toBe(true);
    expect(admitReleaseCut(rule, { ...spliced, signature: signed.status })).toMatch(/line break/);
    const v1AsV2 = { ...base, timestamp: `${base.timestamp}\nseal:2\ngate:{}` };
    expect(admitReleaseCut(rule, { ...v1AsV2, signature: sign(releaseGateSealPayload(base)) })).toMatch(/line break/);
  });
});
