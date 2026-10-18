/**
 * #4027: `chant release publish`'s contract. It refuses a release no cut
 * names, a revoked one, and one with no verified signature (#4049; under
 * identity.gates.release even with --allow-unsigned); it warns when the run has no OIDC token; and with no
 * publish target declared it has nothing to publish. With a target (#4047)
 * it reads them from release.publish and refuses a checkout that is not the
 * release's commit with a clean tree.
 */

import { afterAll, describe, expect, test } from "vitest";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { cutRelease } from "./release-cut";
import { detectProvenance, preparePublish, type PublishPlan, type PublishRefusal } from "./release-publish";
import type { ReleaseArtifact } from "./release-store";
import type { CompiledTarget, TargetCompiler } from "../components/release-compile";
import { hasSshKeygen, TestRepo, type Key } from "../workspace/trust/test-repo";

const repos: TestRepo[] = [];
afterAll(() => {
  for (const r of repos) rmSync(dirname(r.dir), { recursive: true, force: true });
});

const compiler: TargetCompiler = {
  async compile(env): Promise<CompiledTarget> {
    return {
      env,
      params: [],
      components: ["api"],
      buildSteps: {},
      buildInputs: {},
      componentFiles: { api: "api.component.ts" },
      templates: [{ component: "api", path: "dist/api.json", content: `{"env":"${env}"}\n` }],
    };
  },
  async buildArtifacts(): Promise<ReleaseArtifact[]> {
    return [];
  },
};

/** A project, a workspace member when `declaration` is given, with alice and bob as signers and alice a releaser. */
function setup(declaration: Record<string, unknown> | null, opts: { signers?: boolean } = {}): { r: TestRepo; alice: Key; bob: Key; head: string } {
  const r = new TestRepo("release-publish");
  repos.push(r);
  const alice = r.key("alice");
  const bob = r.key("bob");
  if (declaration) {
    r.write("chant.workspace.json", JSON.stringify({ name: "acme", schema: 1, members: [{ name: "root", dir: ".", kind: "other", because: "the publish fixture" }], ...declaration }, null, 2));
    r.write(".chant/allowed_signers", `alice ${alice.pub}\nbob ${bob.pub}\n`);
  } else if (opts.signers) {
    // A plain project with a signers file and no workspace declaration (#4049).
    r.write(".chant/allowed_signers", `alice ${alice.pub}\n`);
  }
  r.write("chant.config.ts", `export default { environments: ["dev", "prod"] };\n`);
  r.write("api.component.ts", "export const api = {};\n");
  const head = r.commit("init");
  r.git(["tag", `ci/green/${head}`]);
  return { r, alice, bob, head };
}

const cut = (r: TestRepo, label: string, sign?: Key, actor = "alice") =>
  cutRelease({ cwd: r.dir, compiler, label, actor, env: {}, now: () => new Date("2026-10-17T10:00:00.000Z"), ...(sign ? { sign: sign.file } : {}) });
const refusal = (p: PublishPlan | { refusal: PublishRefusal }): PublishRefusal | null => ("refusal" in p ? p.refusal : null);
const WORKSTATION: NodeJS.ProcessEnv = { PATH: process.env.PATH };

describe("provenance", () => {
  test("GitHub Actions has OIDC with id-token: write, GitLab with an ID token, a workstation never", () => {
    expect(detectProvenance({})).toEqual({ oidc: false, ci: null, reason: "this run is not in CI, and a workstation has no OIDC token" });
    expect(detectProvenance({ GITHUB_ACTIONS: "true" })).toMatchObject({ oidc: false, ci: "github", reason: expect.stringMatching(/id-token: write/) });
    expect(detectProvenance({ GITHUB_ACTIONS: "true", ACTIONS_ID_TOKEN_REQUEST_URL: "https://x", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "t" })).toMatchObject({ oidc: true, ci: "github" });
    expect(detectProvenance({ GITLAB_CI: "true" })).toMatchObject({ oidc: false, ci: "gitlab", reason: expect.stringMatching(/id_tokens/) });
    expect(detectProvenance({ GITLAB_CI: "true", SIGSTORE_ID_TOKEN: "t" })).toMatchObject({ oidc: true, ci: "gitlab" });
    // A CI variable alone is not a token.
    expect(detectProvenance({ CI: "true", GITHUB_RUN_ID: "1" }).oidc).toBe(false);
  });
});

describe("chant release publish", () => {
  test("warns on a workstation that what it publishes carries no provenance, and has no target to publish to", async () => {
    const { r } = setup(null);
    await cut(r, "v1");
    const plan = await preparePublish({ cwd: r.dir, ref: "v1", env: WORKSTATION, allowUnsigned: true });
    expect(refusal(plan)).toBeNull();
    const p = plan as PublishPlan;
    expect(p.label).toBe("v1");
    expect(p.signature.status).toBe("unsigned");
    expect(p.provenance.oidc).toBe(false);
    expect(p.warning).toBe(
      "this publish runs without OIDC, so what it publishes carries no provenance: this run is not in CI, and a workstation has no OIDC token. Publish from CI to get provenance.",
    );
    expect(p.targets).toEqual([]);
    expect(p.releaseTag).toBe("release/v1");

    const inCi = (await preparePublish({
      cwd: r.dir,
      ref: p.release.releaseDigest,
      env: { GITHUB_ACTIONS: "true", ACTIONS_ID_TOKEN_REQUEST_URL: "https://x", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "t" },
      allowUnsigned: true,
    })) as PublishPlan;
    expect(inCi.warning).toBeNull();
    expect(inCi.label).toBe("v1");
  });

  test("refuses a release no cut names, and one cut from a revoked commit", async () => {
    const { r, head } = setup(null);
    await cut(r, "v1");
    expect(refusal(await preparePublish({ cwd: r.dir, ref: "v9", env: WORKSTATION }))?.code).toBe("release-not-found");
    r.git(["tag", `ci/revoked/${head}`]);
    const revoked = refusal(await preparePublish({ cwd: r.dir, ref: "v1", env: WORKSTATION }));
    expect(revoked?.code).toBe("release-revoked");
    expect(revoked?.message).toMatch(new RegExp(`ci/revoked/${head}`));
  });

  test.skipIf(!hasSshKeygen)("under identity.gates.release, refuses an unsigned cut and publishes a signed one", async () => {
    const gate = { identity: { gates: { release: {} } } };
    const { r, alice } = setup(gate);
    // Cut before the gate applies to the cut, as an older chant or another branch could: write it through the store's own path.
    const { appendCut, makeRelease, persistRelease } = await import("./release-store");
    const head = r.head();
    const unsigned = makeRelease({ member: "root", commit: head, artifactDigests: [], targets: [{ env: "dev", params: [], templates: [] }] });
    await persistRelease(unsigned, [], { cwd: r.dir });
    await appendCut({ releaseDigest: unsigned.releaseDigest, label: "v0", actor: "alice", timestamp: "2026-10-17T09:00:00.000Z", runOrigin: null }, { cwd: r.dir });
    const refused = refusal(await preparePublish({ cwd: r.dir, ref: "v0", env: WORKSTATION }));
    expect(refused?.code).toBe("release-unsigned");
    expect(refused?.fix).toMatch(/chant release cut v0 --sign --yes/);

    await cut(r, "v1", alice);
    const signed = (await preparePublish({ cwd: r.dir, ref: "v1", env: WORKSTATION })) as PublishPlan;
    expect(refusal(signed)).toBeNull();
    expect(signed.signature).toMatchObject({ status: "verified", actor: "alice", key: expect.stringMatching(/^SHA256:/) });
  });

  test.skipIf(!hasSshKeygen)("under identity.gates.release, refuses a cut whose signature does not verify for its actor", async () => {
    const { r, bob } = setup({ identity: { gates: { release: {} } } });
    const { appendCut, makeRelease, persistRelease } = await import("./release-store");
    const { sealReleaseCut } = await import("../workspace/trust/seal");
    const release = makeRelease({ member: "root", commit: r.head(), artifactDigests: [], targets: [{ env: "dev", params: [], templates: [] }] });
    await persistRelease(release, [], { cwd: r.dir });
    // Signed by bob's key, in alice's name.
    const line = { releaseDigest: release.releaseDigest, label: "v2", actor: "alice", timestamp: "2026-10-17T09:00:00.000Z" };
    const signature = sealReleaseCut(bob.file, line).signature;
    await appendCut({ ...line, runOrigin: null, signature }, { cwd: r.dir });
    const refused = refusal(await preparePublish({ cwd: r.dir, ref: "v2", env: WORKSTATION }));
    expect(refused?.code).toBe("release-signature-unverified");
    // --allow-unsigned never overrides the release gate.
    expect(refusal(await preparePublish({ cwd: r.dir, ref: "v2", env: WORKSTATION, allowUnsigned: true }))?.code).toBe("release-signature-unverified");
  });

  test("refuses an unsigned release with no release gate, and publishes it under --allow-unsigned with a warning", async () => {
    const { r } = setup(null);
    await cut(r, "v1");
    const refused = refusal(await preparePublish({ cwd: r.dir, ref: "v1", env: WORKSTATION }));
    expect(refused?.code).toBe("release-unsigned");
    expect(refused?.message).toBe("v1 has no signed cut, and chant release publish publishes only a release signed by a key in .chant/allowed_signers");
    expect(refused?.fix).toContain("chant release cut v1 --sign --yes");
    expect(refused?.fix).toContain("--allow-unsigned");

    const allowed = (await preparePublish({ cwd: r.dir, ref: "v1", env: WORKSTATION, allowUnsigned: true })) as PublishPlan;
    expect(refusal(allowed)).toBeNull();
    expect(allowed.signatureWarning).toBe("v1 has no signed cut; publishing it anyway under --allow-unsigned, so chant release verify v1 will fail for it");
    expect(allowed.cut).toMatchObject({ actor: "alice", label: "v1", signature: null });
  });

  test.skipIf(!hasSshKeygen)("with no release gate, publishes a release signed by a listed key and refuses one signed by a key the signers file does not list", async () => {
    const { r, alice, bob } = setup(null, { signers: true });
    await cut(r, "v1", alice);
    const signed = (await preparePublish({ cwd: r.dir, ref: "v1", env: WORKSTATION })) as PublishPlan;
    expect(refusal(signed)).toBeNull();
    expect(signed.signature).toMatchObject({ status: "verified", actor: "alice" });
    expect(signed.signatureWarning).toBeNull();
    expect(signed.cut?.signature).toMatch(/^-----BEGIN SSH SIGNATURE-----/);

    // bob signs in his own name, and the signers file lists only alice.
    r.write("later.txt", "x\n");
    const later = r.commit("later");
    r.git(["tag", `ci/green/${later}`]);
    await cut(r, "v2", bob, "bob");
    const unlisted = refusal(await preparePublish({ cwd: r.dir, ref: "v2", env: WORKSTATION }));
    expect(unlisted?.code).toBe("release-signature-unverified");
    expect(unlisted?.message).toMatch(/bob has no key in \.chant\/allowed_signers at base/);
  });

  test("--require-provenance refuses a run with no OIDC token and passes one in CI", async () => {
    const { r } = setup(null);
    await cut(r, "v1");
    const refused = refusal(await preparePublish({ cwd: r.dir, ref: "v1", env: WORKSTATION, allowUnsigned: true, requireProvenance: true }));
    expect(refused?.code).toBe("publish-provenance-missing");
    expect(refused?.message).toMatch(/a workstation has no OIDC token/);
    const ci = { GITHUB_ACTIONS: "true", ACTIONS_ID_TOKEN_REQUEST_URL: "https://x", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "t" };
    expect(refusal(await preparePublish({ cwd: r.dir, ref: "v1", env: ci, allowUnsigned: true, requireProvenance: true }))).toBeNull();
  });

  test("reads the targets release.publish declares, and with one refuses a checkout that is not the release's commit or has changes", async () => {
    const { r } = setup(null);
    r.write("chant.config.ts", `export default { environments: ["dev"], release: { publish: [{ type: "npm", packages: ["pkg"] }, { type: "oci", image: "img", repository: "ghcr.io/acme/api" }] } };\n`);
    const head = r.commit("declare targets");
    r.git(["tag", `ci/green/${head}`]);
    await cut(r, "v1");
    const p = (await preparePublish({ cwd: r.dir, ref: "v1", env: WORKSTATION, allowUnsigned: true })) as PublishPlan;
    expect(refusal(p)).toBeNull();
    expect(p.targets.map((t) => [t.kind, t.name, t.destination])).toEqual([
      ["npm", "npm (1 package)", "npm the registry npm's config names"],
      ["oci", "oci ghcr.io/acme/api", "ghcr.io/acme/api"],
    ]);
    expect(p.targets[1]!.credentialEnv).toEqual(["OCI_PASSWORD"]);

    r.write("untracked.txt", "x\n");
    expect(refusal(await preparePublish({ cwd: r.dir, ref: "v1", env: WORKSTATION, allowUnsigned: true }))?.code).toBe("release-worktree-dirty");
    rmSync(`${r.dir}/untracked.txt`);
    r.commit("later");
    const moved = refusal(await preparePublish({ cwd: r.dir, ref: "v1", env: WORKSTATION, allowUnsigned: true }));
    expect(moved?.code).toBe("release-head-mismatch");
    expect(moved?.fix).toContain(`git checkout ${head}`);
  });

  test("refuses a release.publish block that does not validate, before anything is read", async () => {
    const { r } = setup(null);
    await cut(r, "v1");
    r.write("chant.config.ts", `export default { environments: ["dev"], release: { publish: [{ type: "npm", packages: [] }] } };\n`);
    const refused = refusal(await preparePublish({ cwd: r.dir, ref: "v1", env: WORKSTATION, allowUnsigned: true }));
    expect(refused?.code).toBe("publish-config-invalid");
    expect(refused?.message).toMatch(/release\.publish\.0\.packages/);
  });
});

