/**
 * #5164: Sigstore signing at publish. The OCI and forge targets sign what
 * they stage with an injected signer (a fake here; cosign in a job) and push
 * or upload the bundles before anything is revealed; a stage run again keeps
 * the bundles an earlier run made; a publish that should sign and can't is
 * refused before anything is sent; and `release verify --sigstore` checks
 * the bundles the record names. Nothing reaches a network, Fulcio or Rekor.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRedactor } from "./publish-credentials";
import { PublishDeclarationSchema } from "./publish-declaration";
import { referrersTagOf } from "./publish-oci";
import {
  BUNDLE_PREDICATE_ANNOTATION,
  CI_SERVE_BUILDER,
  COSIGN_SIGN_PREDICATE,
  FORGEJO_BUILD_TYPE,
  GITHUB_BUILD_TYPE,
  HOST_BUILD_TYPE,
  RUNNER_FINGERPRINT_ENV,
  WORKSTATION_BUILDER,
  githubOidcIssuer,
  releaseBuildKind,
  SIGSTORE_BUNDLE_MEDIA_TYPE,
  SLSA_BUNDLE_FILE,
  SLSA_PROVENANCE_PREDICATE,
  resolveSigning,
  signingIdentity,
  slsaProvenanceStatement,
  type InTotoStatement,
  type Signer,
  type SigstoreVerifier,
} from "./publish-signing";
import { createPublishTargets } from "./publish-targets";
import { detectProvenance, preparePublish, publishContext, runPublish, type PublishContext } from "./release-publish";
import { makeRelease, type ReleaseArtifact } from "./release-store";
import { verifySigstore } from "./release-verify";
import { cutRelease } from "./release-cut";
import { renderReleaseWorkflow } from "../workspace/release-workflow";
import { TOOL_PINS, toolInstallLine } from "../tool-pins";
import { TestRepo } from "../workspace/trust/test-repo";
import type { CompiledTarget, TargetCompiler } from "../components/release-compile";
import { startFakeForge, startFakeRegistry, writeLockfile, writeOciLayout } from "./__fixtures__/publish-fakes";

const dirs: string[] = [];
const repos: TestRepo[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  for (const r of repos) rmSync(dirname(r.dir), { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "chant-publish-signing-"));
  dirs.push(d);
  return d;
};
const sha = (b: Uint8Array | string) => `sha256:${createHash("sha256").update(b).digest("hex")}`;

const GITHUB_ENV = {
  GITHUB_ACTIONS: "true",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.test",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "id-request-token",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "acme/api",
  GITHUB_REPOSITORY_ID: "11",
  GITHUB_REPOSITORY_OWNER_ID: "22",
  GITHUB_WORKFLOW_REF: "acme/api/.github/workflows/chant-release.yml@refs/tags/release/v1.4.0",
  GITHUB_REF: "refs/tags/release/v1.4.0",
  GITHUB_EVENT_NAME: "push",
  GITHUB_RUN_ID: "99",
  GITHUB_RUN_ATTEMPT: "1",
  RUNNER_ENVIRONMENT: "github-hosted",
};
const IDENTITY = { issuer: "https://token.actions.githubusercontent.com", identity: "^https://github\\.com/acme/api/" };

/** A signer whose bundle names what it signed, so the fake verifier can check it. Each signing gets new bytes, as a real one does. */
function fakeSigner(): Signer & { calls: string[] } {
  const calls: string[] = [];
  let n = 0;
  const out = (v: unknown) => new Uint8Array(Buffer.from(JSON.stringify({ mediaType: SIGSTORE_BUNDLE_MEDIA_TYPE, n: n++, ...(v as object) })));
  return {
    name: "fake-cosign",
    calls,
    unavailable: () => null,
    signBlob: async (bytes, name) => {
      calls.push(`blob ${name}`);
      return out({ blob: sha(bytes) });
    },
    signStatement: async (s: InTotoStatement) => {
      calls.push(`statement ${s.predicateType}`);
      return out({ statement: s });
    },
  };
}

/** A verifier that reads the fake bundles. */
function fakeVerifier(): SigstoreVerifier & { images: string[] } {
  const images: string[] = [];
  const read = (b: Uint8Array) => JSON.parse(Buffer.from(b).toString("utf-8")) as { blob?: string; statement?: InTotoStatement };
  return {
    name: "fake-cosign",
    images,
    unavailable: () => null,
    verifyBlob: async (b, digest) => (read(b).blob === digest ? null : "artifact does not match digest"),
    verifyBlobAttestation: async (b, digest, pt) => {
      const s = read(b).statement;
      return s?.predicateType === pt && s.subject.some((x) => `sha256:${x.digest.sha256}` === digest) ? null : "no matching attestation";
    },
    verifyImage: async (ref) => {
      images.push(`sig ${ref}`);
      return null;
    },
    verifyImageAttestation: async (ref, pt) => {
      images.push(`att ${pt} ${ref}`);
      return null;
    },
  };
}

function context(cwd: string, over: Partial<PublishContext> = {}): PublishContext & { lines: string[] } {
  const env = over.env ?? {};
  const redactor = createRedactor(env);
  const lines: string[] = [];
  const release = makeRelease({ member: null, commit: "c0ffee".padEnd(40, "0"), artifactDigests: [] as ReleaseArtifact[], targets: [{ env: "dev", params: [], templates: [] }] });
  return { release, label: "v1.4.0", releaseTag: "release/v1.4.0", provenance: { oidc: true, ci: "github", reason: "" }, cwd, tag: null, env, redactor, log: (l) => lines.push(l), ...over, lines };
}

describe("when a publish signs", () => {
  test("off by default, on with release.signing or under supply-chain, and false turns the group's off with a warning", () => {
    const none = new Set<never>();
    const sc = new Set(["supply-chain" as const]);
    expect(resolveSigning(undefined, none)).toMatchObject({ on: false, warning: null });
    expect(resolveSigning(true, none)).toMatchObject({ on: true, from: "config" });
    expect(resolveSigning({ identity: "^x", issuer: "https://i" }, none)).toMatchObject({ on: true, identity: "^x", issuer: "https://i" });
    expect(resolveSigning(undefined, sc)).toMatchObject({ on: true, from: "supply-chain" });
    expect(resolveSigning(false, sc).on).toBe(false);
    expect(resolveSigning(false, sc).warning).toContain("supply-chain");
    expect(resolveSigning(false, none).warning).toBeNull();
  });

  test("a keyless identity comes from the CI job: GitHub with id-token, GitLab with SIGSTORE_ID_TOKEN, nowhere else", () => {
    expect(signingIdentity(GITHUB_ENV)).toEqual({ identity: IDENTITY });
    expect(signingIdentity({ GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "a/b" })).toMatchObject({ reason: expect.stringContaining("id-token: write") });
    expect(signingIdentity({ GITLAB_CI: "true", CI_SERVER_URL: "https://gitlab.com", CI_PROJECT_PATH: "g/p", SIGSTORE_ID_TOKEN: "t" })).toEqual({ identity: { issuer: "https://gitlab.com", identity: "^https://gitlab\\.com/g/p//" } });
    // npm's ID token has npm's audience, which Fulcio does not take.
    expect(signingIdentity({ GITLAB_CI: "true", CI_PROJECT_PATH: "g/p", NPM_ID_TOKEN: "t" })).toMatchObject({ reason: expect.stringContaining("SIGSTORE_ID_TOKEN") });
    expect(signingIdentity({})).toMatchObject({ reason: expect.stringContaining("not in GitHub Actions or GitLab CI") });
  });

  test("SLSA provenance in GitHub Actions is the predicate actions/attest-build-provenance writes, resolving the release's commit", () => {
    const ctx = context(temp(), { env: GITHUB_ENV });
    const s = slsaProvenanceStatement(ctx, [{ name: "api.tar.gz", digest: `sha256:${"a".repeat(64)}` }]);
    expect(s).toMatchObject({
      _type: "https://in-toto.io/Statement/v1",
      subject: [{ name: "api.tar.gz", digest: { sha256: "a".repeat(64) } }],
      predicateType: SLSA_PROVENANCE_PREDICATE,
      predicate: {
        buildDefinition: {
          buildType: GITHUB_BUILD_TYPE,
          externalParameters: { workflow: { ref: "refs/tags/release/v1.4.0", repository: "https://github.com/acme/api", path: ".github/workflows/chant-release.yml" } },
          internalParameters: { github: { event_name: "push", repository_id: "11", repository_owner_id: "22", runner_environment: "github-hosted" }, chant: { label: "v1.4.0" } },
          resolvedDependencies: [{ uri: "git+https://github.com/acme/api@refs/tags/release/v1.4.0", digest: { gitCommit: ctx.release.commit } }],
        },
        runDetails: { builder: { id: "https://github.com/acme/api/.github/workflows/chant-release.yml@refs/tags/release/v1.4.0" }, metadata: { invocationId: "https://github.com/acme/api/actions/runs/99/attempts/1" } },
      },
    });
  });
});

describe("the environment a release is built in (#5458)", () => {
  const FORGEJO_ENV = {
    GITHUB_ACTIONS: "true",
    FORGEJO_ACTIONS: "true",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://code.example/api/actions/_apis/pipelines/idtoken",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "t",
    FORGEJO_SERVER_URL: "https://code.example",
    GITHUB_SERVER_URL: "https://code.example",
    FORGEJO_REPOSITORY: "acme/api",
    GITHUB_REPOSITORY: "acme/api",
    FORGEJO_WORKFLOW_REF: "acme/api/.forgejo/workflows/chant-release.yml@refs/tags/release/v1.4.0",
    FORGEJO_REF: "refs/tags/release/v1.4.0",
    FORGEJO_RUN_NUMBER: "7",
    FORGEJO_RUN_ID: "1234",
    FORGEJO_EVENT_NAME: "push",
  };

  test("a Forgejo runner is not taken for GitHub, by FORGEJO_ACTIONS, GITEA_ACTIONS, or an older runner's API URL", () => {
    expect(releaseBuildKind(FORGEJO_ENV)).toBe("forgejo");
    expect(releaseBuildKind({ GITHUB_ACTIONS: "true", GITEA_ACTIONS: "true" })).toBe("forgejo");
    expect(releaseBuildKind({ GITHUB_ACTIONS: "true", GITHUB_API_URL: "https://code.example/api/v1" })).toBe("forgejo");
    expect(releaseBuildKind({ GITHUB_ACTIONS: "true", GITHUB_API_URL: "https://ghes.example/api/v3" })).toBe("github");
    expect(releaseBuildKind(GITHUB_ENV)).toBe("github");
    expect(releaseBuildKind({ GITLAB_CI: "true" })).toBe("gitlab");
    expect(releaseBuildKind({ [RUNNER_FINGERPRINT_ENV]: "SHA256:abc" })).toBe("host");
    expect(releaseBuildKind({})).toBe("workstation");
    expect(signingIdentity(FORGEJO_ENV)).toMatchObject({ reason: expect.stringContaining("Forgejo") });
    expect(detectProvenance(FORGEJO_ENV)).toMatchObject({ oidc: false, ci: "forgejo" });
    expect(detectProvenance(GITHUB_ENV)).toMatchObject({ oidc: true, ci: "github" });
  });

  test("the GitHub issuer follows the server: github.com, a GHE.com host, GitHub Enterprise Server", () => {
    expect(githubOidcIssuer("https://github.com")).toBe("https://token.actions.githubusercontent.com");
    expect(githubOidcIssuer("https://acme.ghe.com/")).toBe("https://token.actions.acme.ghe.com");
    expect(githubOidcIssuer("https://ghes.example")).toBe("https://ghes.example/_services/token");
    expect(signingIdentity({ ...GITHUB_ENV, GITHUB_SERVER_URL: "https://ghes.example" })).toEqual({ identity: { issuer: "https://ghes.example/_services/token", identity: "^https://ghes\\.example/acme/api/" } });
  });

  test("a Forgejo job's statement names Forgejo's server and workflow, not GitHub", () => {
    const ctx = context(temp(), { env: FORGEJO_ENV });
    const s = slsaProvenanceStatement(ctx, [{ name: "api.tar.gz", digest: `sha256:${"a".repeat(64)}` }]);
    expect(s.predicate).toMatchObject({
      buildDefinition: {
        buildType: FORGEJO_BUILD_TYPE,
        externalParameters: { workflow: { ref: "refs/tags/release/v1.4.0", repository: "https://code.example/acme/api", path: ".forgejo/workflows/chant-release.yml" } },
        internalParameters: { forgejo: { event_name: "push", run_id: "1234" }, chant: { label: "v1.4.0" } },
        resolvedDependencies: [{ uri: "git+https://code.example/acme/api@refs/tags/release/v1.4.0", digest: { gitCommit: ctx.release.commit } }],
      },
      runDetails: { builder: { id: "https://code.example/acme/api/.forgejo/workflows/chant-release.yml@refs/tags/release/v1.4.0" }, metadata: { invocationId: "https://code.example/acme/api/actions/runs/7" } },
    });
    expect(JSON.stringify(s)).not.toContain("github");
  });

  test("a ci serve host is named by its runner key's fingerprint, and a workstation by neither, each with the origin it built from and no credentials", () => {
    const dir = temp();
    execFileSync("git", ["init", "-q", dir]);
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://user:secret@git.example/acme/api.git"]);
    const host = slsaProvenanceStatement(context(dir, { env: { [RUNNER_FINGERPRINT_ENV]: "SHA256:abc/def" } }), [{ name: "a", digest: `sha256:${"b".repeat(64)}` }]);
    expect(host.predicate).toMatchObject({
      buildDefinition: { buildType: HOST_BUILD_TYPE, externalParameters: { source: "https://git.example/acme/api.git" }, internalParameters: { host: { runner: "ci-serve", runnerKey: "SHA256:abc/def" } } },
      runDetails: { builder: { id: `${CI_SERVE_BUILDER}SHA256%3Aabc%2Fdef` } },
    });
    expect(JSON.stringify(host)).not.toContain("secret");
    const desk = slsaProvenanceStatement(context(dir, { env: {} }), [{ name: "a", digest: `sha256:${"b".repeat(64)}` }]);
    expect(desk.predicate).toMatchObject({ buildDefinition: { buildType: HOST_BUILD_TYPE, internalParameters: { host: { runner: "workstation", runnerKey: null } } }, runDetails: { builder: { id: WORKSTATION_BUILDER } } });
    expect(JSON.stringify(desk)).not.toContain("github");
  });
});

describe("the OCI target", () => {
  test("pushes a cosign signature and SLSA provenance as bundle referrers in the stage, lists them under the referrers tag, and does not sign again", async () => {
    const reg = await startFakeRegistry({ username: "robot", password: "pw-sign-1", token: "tok-sign-1" });
    try {
      const dir = temp();
      const { digest } = writeOciLayout(join(dir, "image"));
      writeLockfile(dir);
      const repository = `${reg.host}/acme/api`;
      const [target] = await createPublishTargets([PublishDeclarationSchema.parse({ type: "oci", image: "image", repository })], {});
      const signer = fakeSigner();
      const ctx = context(dir, { env: { ...GITHUB_ENV, OCI_USERNAME: "robot", OCI_PASSWORD: "pw-sign-1" }, signing: { signer, identity: IDENTITY } });

      const plan = await target!.plan(ctx);
      expect(plan.filter((i) => i.attachment === "signature" || i.attachment === "attestation")).toEqual([
        { name: "cosign signature", destination: `${repository}, a referrer of the image, signed when staged`, attachment: "signature", signs: [{ name: `${repository}@${digest}`, digest }], predicateType: COSIGN_SIGN_PREDICATE, sigstore: IDENTITY },
        { name: "SLSA provenance", destination: `${repository}, a referrer of the image, signed when staged`, attachment: "attestation", signs: [{ name: `${repository}@${digest}`, digest }], predicateType: SLSA_PROVENANCE_PREDICATE, sigstore: IDENTITY },
      ]);
      expect(signer.calls).toEqual([]);

      const staged = await target!.stage(ctx);
      expect(signer.calls).toEqual([`statement ${COSIGN_SIGN_PREDICATE}`, `statement ${SLSA_PROVENANCE_PREDICATE}`]);
      // No tag points at the image yet, apart from the referrers tag.
      expect([...reg.manifests.keys()].filter((k) => !k.startsWith("sha256:"))).toEqual([referrersTagOf(digest)]);
      const index = JSON.parse(reg.manifests.get(referrersTagOf(digest))!.bytes.toString("utf-8")) as { manifests: Array<{ digest: string; artifactType: string; annotations: Record<string, string> }> };
      expect(index.manifests.map((m) => [m.artifactType, m.annotations[BUNDLE_PREDICATE_ANNOTATION]])).toEqual([
        [SIGSTORE_BUNDLE_MEDIA_TYPE, COSIGN_SIGN_PREDICATE],
        [SIGSTORE_BUNDLE_MEDIA_TYPE, SLSA_PROVENANCE_PREDICATE],
      ]);
      const sig = JSON.parse(reg.manifests.get(index.manifests[0]!.digest)!.bytes.toString("utf-8")) as { subject: { digest: string }; layers: Array<{ mediaType: string; digest: string }> };
      expect(sig.subject.digest).toBe(digest);
      expect(sig.layers[0]!.mediaType).toBe(SIGSTORE_BUNDLE_MEDIA_TYPE);
      const bundle = JSON.parse(reg.blobs.get(sig.layers[0]!.digest)!.toString("utf-8")) as { statement: InTotoStatement };
      expect(bundle.statement).toMatchObject({ predicateType: COSIGN_SIGN_PREDICATE, subject: [{ digest: { sha256: digest.slice(7) } }], predicate: {} });
      expect(staged.items.filter((i) => i.attachment === "signature" || i.attachment === "attestation").map((i) => i.digest)).toEqual(index.manifests.map((m) => m.digest));

      // A stage run again finds both and signs nothing.
      const again = await target!.stage(ctx);
      expect(signer.calls).toHaveLength(2);
      expect(again.items.filter((i) => i.attachment === "signature").map((i) => i.present)).toEqual([true]);
      const published = await target!.reveal(ctx, staged);
      expect(published.items.filter((i) => i.attachment === "attestation")).toHaveLength(1);
    } finally {
      await reg.close();
    }
  });

  test("signs nothing when the publish does not sign", async () => {
    const reg = await startFakeRegistry({ username: "robot", password: "pw-sign-2", token: "tok-sign-2" });
    try {
      const dir = temp();
      writeOciLayout(join(dir, "image"));
      writeLockfile(dir);
      const [target] = await createPublishTargets([PublishDeclarationSchema.parse({ type: "oci", image: "image", repository: `${reg.host}/acme/api` })], {});
      const ctx = context(dir, { env: { OCI_USERNAME: "robot", OCI_PASSWORD: "pw-sign-2" } });
      const staged = await target!.stage(ctx);
      expect(staged.items.map((i) => i.attachment)).toEqual([undefined, "sbom", "provenance"]);
      expect([...reg.manifests.keys()].every((k) => k.startsWith("sha256:"))).toBe(true);
    } finally {
      await reg.close();
    }
  });
});

describe("the forge target", () => {
  test("uploads a bundle beside each file and SLSA provenance over the assets to the draft, and keeps them on a stage run again", async () => {
    const dir = temp();
    writeFileSync(join(dir, "api-linux.tar.gz"), "binary bytes");
    writeLockfile(dir);
    const api = "https://api.github.test";
    const forge = startFakeForge("github", api, "acme/api");
    const [target] = await createPublishTargets([PublishDeclarationSchema.parse({ type: "forge", forge: "github", repo: "acme/api", api, assets: ["api-linux.tar.gz"] })], { fetch: forge.fetch });
    const signer = fakeSigner();
    const ctx = context(dir, { env: { ...GITHUB_ENV, GITHUB_TOKEN: "ghs_sign" }, signing: { signer, identity: IDENTITY } });
    const names = ["api-linux.tar.gz", "sbom.spdx.json", "release.intoto.json", "api-linux.tar.gz.sigstore.json", "sbom.spdx.json.sigstore.json", "release.intoto.json.sigstore.json", SLSA_BUNDLE_FILE];

    expect((await target!.plan(ctx)).map((i) => i.name)).toEqual(names);
    const staged = await target!.stage(ctx);
    expect(signer.calls).toEqual(["blob api-linux.tar.gz", "blob sbom.spdx.json", "blob release.intoto.json", `statement ${SLSA_PROVENANCE_PREDICATE}`]);
    expect(forge.releases[0]!.assets.map((a) => a.name)).toEqual(names);
    expect(forge.visible()).toEqual([]);
    const slsa = staged.items.find((i) => i.name === SLSA_BUNDLE_FILE)!;
    expect(slsa).toMatchObject({ attachment: "attestation", predicateType: SLSA_PROVENANCE_PREDICATE, signs: [{ name: "api-linux.tar.gz", digest: sha("binary bytes") }], sigstore: IDENTITY });

    await target!.stage(ctx);
    expect(signer.calls).toHaveLength(4);
    await target!.reveal(ctx, staged);
    expect(forge.visible()).toEqual([{ tag: "release/v1.4.0", assets: names }]);
  });

  test("signs each file a release.artifacts entry attaches, goreleaser's included, and a prerelease is signed as a stable release is", async () => {
    const dir = temp();
    const files = { "dist/tool_linux_amd64.tar.gz": "linux build", "dist/tool_darwin_arm64.tar.gz": "darwin build", "dist/checksums.txt": "sums" };
    mkdirSync(join(dir, "dist"));
    for (const [f, b] of Object.entries(files)) writeFileSync(join(dir, f), b);
    writeLockfile(dir);
    const api = "https://api.github.test";
    const forge = startFakeForge("github", api, "acme/api");
    const [target] = await createPublishTargets([PublishDeclarationSchema.parse({ type: "forge", forge: "github", repo: "acme/api", api, assets: ["artifact:tool"] })], { fetch: forge.fetch });
    const signer = fakeSigner();
    const artifactDigests: ReleaseArtifact[] = Object.entries(files).map(([path, b]) => ({ component: "tool", kind: "asset", path, digest: sha(b) }));
    const release = makeRelease({ member: null, commit: "c0ffee".padEnd(40, "0"), artifactDigests, targets: [{ env: "dev", params: [], templates: [] }] });
    const ctx = context(dir, { release, label: "v1.5.0-rc.1", releaseTag: "release/v1.5.0-rc.1", env: { ...GITHUB_ENV, GITHUB_TOKEN: "ghs_sign" }, signing: { signer, identity: IDENTITY } });

    const staged = await target!.stage(ctx);
    const recorded = ["dist/checksums.txt", "dist/tool_darwin_arm64.tar.gz", "dist/tool_linux_amd64.tar.gz"].map((p) => p.slice("dist/".length));
    expect(signer.calls.filter((c) => c.startsWith("blob "))).toEqual([...recorded, "sbom.spdx.json", "release.intoto.json"].map((n) => `blob ${n}`));
    const slsa = staged.items.find((i) => i.name === SLSA_BUNDLE_FILE)!;
    expect(slsa.signs).toEqual(recorded.map((n) => ({ name: n, digest: sha(files[`dist/${n}` as keyof typeof files]) })));
    await target!.reveal(ctx, staged);
    expect(forge.releases[0]).toMatchObject({ prerelease: true, draft: false });
    expect(forge.visible()[0]!.assets).toEqual(expect.arrayContaining([...recorded.map((n) => `${n}.sigstore.json`), SLSA_BUNDLE_FILE]));
  });
});

describe("a publish that signs, end to end", () => {
  const compiler: TargetCompiler = {
    async compile(env): Promise<CompiledTarget> {
      return { env, params: [], components: ["api"], buildSteps: {}, buildInputs: {}, componentFiles: { api: "api.component.ts" }, templates: [{ component: "api", path: "dist/api.json", content: `{"env":"${env}"}\n` }] };
    },
    async buildArtifacts(): Promise<ReleaseArtifact[]> {
      return [];
    },
  };
  const API = "https://api.github.test";

  let r: TestRepo;
  // The repository and its cut are made once, outside the tests' time budget.
  beforeAll(async () => {
    r = new TestRepo("publish-signing");
    repos.push(r);
    r.write(
      "chant.config.ts",
      `export default { environments: ["dev"], release: { signing: true, publish: [{ type: "forge", forge: "github", repo: "acme/api", api: "${API}", assets: ["dist/api.tar.gz"] }] } };\n`,
    );
    r.write("api.component.ts", "export const api = {};\n");
    r.write(".gitignore", "node_modules\n");
    r.write("dist/api.tar.gz", "asset bytes");
    writeLockfile(r.dir);
    const head = r.commit("init");
    r.git(["tag", `ci/green/${head}`]);
    await cutRelease({ cwd: r.dir, compiler, label: "v2", actor: "alice", env: {}, now: () => new Date("2026-10-17T10:00:00.000Z") });
  }, 120_000);
  const env = { PATH: process.env.PATH, ...GITHUB_ENV, GITHUB_TOKEN: "ghs_e2e" };

  test("is refused before anything is sent without an OIDC token, or without cosign", async () => {
    const forge = startFakeForge("github", API, "acme/api");
    const signer = fakeSigner();
    const workstation = await preparePublish({ cwd: r.dir, ref: "v2", env: { PATH: process.env.PATH }, deps: { fetch: forge.fetch, signer } });
    expect(workstation).toMatchObject({ refusal: { code: "publish-signing-no-oidc" } });
    const noTool = await preparePublish({ cwd: r.dir, ref: "v2", env, deps: { fetch: forge.fetch, signer: { ...signer, unavailable: () => "cosign is not there" } } });
    expect(noTool).toMatchObject({ refusal: { code: "publish-signing-tool-missing" } });
    expect(forge.calls).toEqual([]);
    expect(signer.calls).toEqual([]);
  });

  test("signs in CI, and release verify --sigstore checks what the publish recorded", async () => {
    const forge = startFakeForge("github", API, "acme/api");
    const signer = fakeSigner();

    const plan = await preparePublish({ cwd: r.dir, ref: "v2", env, deps: { fetch: forge.fetch, signer } });
    if ("refusal" in plan) throw new Error(plan.refusal.message);
    expect(plan.signing?.identity).toEqual(IDENTITY);
    const ctx = publishContext(plan, { cwd: r.dir, env, log: () => undefined });
    await runPublish({ cwd: r.dir, release: plan.release, label: plan.label, targets: plan.targets, ctx });
    expect(forge.visible()[0]!.assets).toContain(SLSA_BUNDLE_FILE);

    const verifier = fakeVerifier();
    const unchecked = await verifySigstore({ cwd: r.dir, releaseDigest: plan.release.releaseDigest, verifier });
    expect(unchecked.status).toBe("failed");
    expect(unchecked.checks.every((c) => c.status === "unchecked")).toBe(true);

    // The assets as `gh release download` leaves them.
    const download = join(dirname(r.dir), "download");
    mkdirSync(download);
    for (const a of forge.releases[0]!.assets) writeFileSync(join(download, a.name), a.bytes);
    const ok = await verifySigstore({ cwd: r.dir, releaseDigest: plan.release.releaseDigest, assetsDir: download, verifier });
    expect(ok.status).toBe("verified");
    expect(ok.checks.map((c) => c.name)).toEqual(["api.tar.gz.sigstore.json", "sbom.spdx.json.sigstore.json", "release.intoto.json.sigstore.json", SLSA_BUNDLE_FILE]);

    // A changed asset fails, beside its bundle.
    writeFileSync(join(download, "api.tar.gz"), "other bytes");
    const bad = await verifySigstore({ cwd: r.dir, releaseDigest: plan.release.releaseDigest, assetsDir: download, verifier });
    expect(bad.status).toBe("failed");
    expect(bad.checks.find((c) => c.name === "api.tar.gz.sigstore.json")).toMatchObject({ status: "failed" });
  });
});

describe("the release workflow", () => {
  test("downloads cosign pinned by SHA-256 when the publish signs, and not otherwise", () => {
    const pin = TOOL_PINS.cosign.platforms["linux/amd64"];
    const signing = renderReleaseWorkflow({ forge: "github", groups: new Set(), signing: true, publish: [{ type: "forge", forge: "github" }] });
    expect(signing).toContain(pin.url);
    expect(signing).toContain(`${pin.sha256}  $RUNNER_TEMP/cosign`);
    expect(signing).toContain("CHANT_COSIGN=$RUNNER_TEMP/cosign");
    const gitlab = renderReleaseWorkflow({ forge: "gitlab", groups: new Set(), signing: true });
    expect(gitlab).toContain("export CHANT_COSIGN=/tmp/cosign");
    expect(renderReleaseWorkflow({ forge: "github", groups: new Set() })).not.toContain("cosign");
  });

  test("a dispatched release installs cosign in the cut and publish jobs, never in a per-platform build job, and GitLab's cut gets the signing token for the doctor", () => {
    const pipeline = { trigger: "dispatch" as const, builds: [{ name: "arm", runner: "ubuntu-24.04-arm", build: "make", outputs: ["dist/arm"] }] };
    const github = renderReleaseWorkflow({ forge: "github", groups: new Set(), signing: true, pipeline, publish: [{ type: "forge", forge: "github" }] });
    const job = (text: string, name: string) => text.split(/\n(?=  [a-z][\w-]*:\n)/).find((j) => j.startsWith(`  ${name}:`)) ?? "";
    expect(job(github, "build-arm")).not.toContain("cosign");
    expect(job(github, "cut")).toContain("CHANT_COSIGN=$RUNNER_TEMP/cosign");
    expect(job(github, "publish")).toContain("CHANT_COSIGN=$RUNNER_TEMP/cosign");
    // The doctor runs after cosign is installed.
    expect(job(github, "cut").indexOf("cosign")).toBeLessThan(job(github, "cut").indexOf("release doctor"));

    const gitlab = renderReleaseWorkflow({ forge: "gitlab", groups: new Set(), signing: true, pipeline: { ...pipeline, builds: [{ ...pipeline.builds[0]!, runner: "arm" }] } });
    const gjob = (name: string) => gitlab.split(/\n\n/).find((j) => j.startsWith(`${name}:`)) ?? "";
    expect(gjob("chant-release-build-arm")).not.toContain("cosign");
    expect(gjob("chant-release-cut")).toContain("CHANT_COSIGN=/tmp/cosign");
    expect(gjob("chant-release-cut")).toContain("SIGSTORE_ID_TOKEN");
    expect(gjob("chant-release-publish")).toContain("SIGSTORE_ID_TOKEN");
    const unsigned = renderReleaseWorkflow({ forge: "gitlab", groups: new Set(), pipeline: { ...pipeline, builds: [] } });
    expect(unsigned.split(/\n\n/).find((j) => j.startsWith("chant-release-cut:"))).not.toContain("SIGSTORE_ID_TOKEN");
  });

  test("one pin table: goreleaser's archive row unpacks the binary, cosign's row is the binary", () => {
    expect(toolInstallLine(TOOL_PINS.goreleaser, "linux/amd64", "/tmp/goreleaser")).toBe(
      `mkdir -p "/tmp/goreleaser" && curl -fsSL -o "/tmp/goreleaser/goreleaser.tar.gz" ${TOOL_PINS.goreleaser.platforms["linux/amd64"]!.url} && echo "${TOOL_PINS.goreleaser.platforms["linux/amd64"]!.sha256}  /tmp/goreleaser/goreleaser.tar.gz" | sha256sum -c - && tar -xzf "/tmp/goreleaser/goreleaser.tar.gz" -C "/tmp/goreleaser" goreleaser`,
    );
    expect(toolInstallLine(TOOL_PINS.cosign, "linux/arm64", "/tmp")).toMatch(/cosign-linux-arm64 && echo "[0-9a-f]{64}  \/tmp\/cosign" \| sha256sum -c - && chmod \+x "\/tmp\/cosign"$/);
    expect(() => toolInstallLine(TOOL_PINS.goreleaser, "darwin/arm64", "/tmp")).toThrow(/pinned for linux\/amd64, linux\/arm64/);
  });
});
