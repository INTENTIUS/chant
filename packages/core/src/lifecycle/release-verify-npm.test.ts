/**
 * #5572: `release verify --sigstore` on a release whose only target is npm.
 * A publish from CI passes `--provenance`, so the registry keeps a
 * Sigstore-signed SLSA provenance statement for each package; the npm target
 * records the identity it names, and verify reads the statement from the
 * registry's attestations and checks it like an OCI or forge bundle. A
 * fake npm, a fake registry behind an injected fetch and a fake verifier
 * stand in for npm, npmjs.org and cosign: nothing reaches a network.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cutRelease } from "./release-cut";
import { preparePublish, publishContext, runPublish, type PublishFetch } from "./release-publish";
import type { ReleaseArtifact } from "./release-store";
import { carriedVerification, npmAttestationsUrl, npmVersionUrl, verifyRelease, verifySigstore, type ReleaseVerification } from "./release-verify";
import { SLSA_PROVENANCE_PREDICATE, cosignVerifier, type InTotoStatement, type SigstoreVerifier } from "./publish-signing";
import { writeFakeNpm, writeLockfile, writePackage } from "./__fixtures__/publish-fakes";
import { TestRepo } from "../workspace/trust/test-repo";
import type { CompiledTarget, TargetCompiler } from "../components/release-compile";

const REGISTRY = "https://registry.npm.test";
const NAME = "@acme/core";
const VERSION = "1.0.0";
const TARBALL = Buffer.from("the packed bytes of @acme/core@1.0.0");
const SHA512 = createHash("sha512").update(TARBALL).digest();

const GITHUB_ENV = {
  GITHUB_ACTIONS: "true",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.test",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "id-request-token",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "acme/api",
  GITHUB_RUN_ID: "99",
};
const IDENTITY = { issuer: "https://token.actions.githubusercontent.com", identity: "^https://github\\.com/acme/api/" };

/** The provenance npm writes for a package: an SLSA statement over its tarball's SHA-512, as the fake verifier reads it. */
const slsaBundle = (sha512: Buffer) => ({
  mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
  statement: { _type: "https://in-toto.io/Statement/v1", subject: [{ name: `pkg:npm/%40acme/core@${VERSION}`, digest: { sha512: sha512.toString("hex") } }], predicateType: SLSA_PROVENANCE_PREDICATE, predicate: {} },
});
const PUBLISH_ATTESTATION = { predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1", bundle: { mediaType: "application/vnd.dev.sigstore.bundle+json;version=0.2" } };

/** A registry answering the attestations and version manifest of `@acme/core@1.0.0`; `attestations` is the body and type of the attestations answer. */
function fakeRegistry(attestations: { status: number; body: string; type: string } | null): PublishFetch & { urls: string[] } {
  const urls: string[] = [];
  const answer = (status: number, body: string, type = "application/json") => ({ ok: status < 400, status, headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? type : null) }, text: async () => body });
  const f = async (url: string) => {
    urls.push(url);
    if (url === npmAttestationsUrl(REGISTRY, NAME, VERSION)) return attestations ? answer(attestations.status, attestations.body, attestations.type) : answer(404, '{"error":"Not found"}');
    if (url === npmVersionUrl(REGISTRY, NAME, VERSION)) return answer(200, JSON.stringify({ name: NAME, version: VERSION, dist: { integrity: `sha512-${SHA512.toString("base64")}` } }));
    return answer(404, '{"error":"Not found"}');
  };
  return Object.assign(f, { urls });
}

const withProvenance = (sha512 = SHA512) => ({ status: 200, type: "application/json", body: JSON.stringify({ attestations: [PUBLISH_ATTESTATION, { predicateType: SLSA_PROVENANCE_PREDICATE, bundle: slsaBundle(sha512) }] }) });

/** A verifier that reads the fake bundle: the predicate type, the subject's digest under the algorithm given, and the identity recorded. */
function fakeVerifier(): SigstoreVerifier & { calls: Array<{ digest: string; identity: unknown }> } {
  const calls: Array<{ digest: string; identity: unknown }> = [];
  return {
    name: "fake-cosign",
    calls,
    unavailable: () => null,
    verifyBlob: async () => "not expected",
    verifyBlobAttestation: async (b, digest, pt, id) => {
      calls.push({ digest, identity: id });
      const s = (JSON.parse(Buffer.from(b).toString("utf-8")) as { statement?: InTotoStatement }).statement;
      const [alg, hex] = digest.split(":");
      if (JSON.stringify(id) !== JSON.stringify(IDENTITY)) return "none of the expected identities matched";
      return s?.predicateType === pt && s.subject.some((x) => x.digest[alg!] === hex) ? null : "no matching attestation";
    },
    verifyImage: async () => "not expected",
    verifyImageAttestation: async () => "not expected",
  };
}

const compiler: TargetCompiler = {
  async compile(env): Promise<CompiledTarget> {
    return { env, params: [], components: ["api"], buildSteps: {}, buildInputs: {}, componentFiles: { api: "api.component.ts" }, templates: [{ component: "api", path: "dist/api.json", content: `{"env":"${env}"}\n` }] };
  },
  async buildArtifacts(): Promise<ReleaseArtifact[]> {
    return [];
  },
};

const repos: TestRepo[] = [];
afterAll(() => {
  for (const r of repos) rmSync(dirname(r.dir), { recursive: true, force: true });
});

describe("release verify --sigstore on an npm-only release", () => {
  let r: TestRepo;
  const releases: Record<"v1" | "v2", string> = { v1: "", v2: "" };

  /** Publish `label` with `env` to a fake npm of its own. */
  const publish = async (label: "v1" | "v2", env: NodeJS.ProcessEnv) => {
    const npm = writeFakeNpm(join(dirname(r.dir), `bin-${label}`), join(dirname(r.dir), `npm-${label}.log`));
    const plan = await preparePublish({ cwd: r.dir, ref: label, env, deps: { npm } });
    if ("refusal" in plan) throw new Error(plan.refusal.message);
    const ctx = publishContext(plan, { cwd: r.dir, env, log: () => undefined });
    await runPublish({ cwd: r.dir, release: plan.release, label: plan.label, targets: plan.targets, ctx });
    releases[label] = plan.release.releaseDigest;
    return readFileSync(join(dirname(r.dir), `npm-${label}.log`), "utf-8");
  };

  // The repository, its two cuts and their publishes are made once, outside the tests' time budget.
  beforeAll(async () => {
    r = new TestRepo("npm-provenance");
    repos.push(r);
    r.write("chant.config.ts", `export default { environments: ["dev"], release: { publish: [{ type: "npm", packages: ["pkg"], registry: "${REGISTRY}", access: "public" }] } };\n`);
    r.write("api.component.ts", "export const api = {};\n");
    writePackage(join(r.dir, "pkg"), NAME, VERSION);
    writeLockfile(r.dir);
    r.git(["tag", `ci/green/${r.commit("init")}`]);
    // v1 from a CI job with an OIDC token, so with --provenance; v2 from a workstation, without.
    await cutRelease({ cwd: r.dir, compiler, label: "v1", actor: "ci", env: {}, now: () => new Date("2026-11-24T10:00:00.000Z") });
    expect(await publish("v1", { PATH: process.env.PATH, ...GITHUB_ENV })).toContain('"--provenance"');
    r.git(["tag", `ci/green/${r.commit("v2")}`]);
    await cutRelease({ cwd: r.dir, compiler, label: "v2", actor: "ci", env: {}, now: () => new Date("2026-11-24T11:00:00.000Z") });
    expect(await publish("v2", { PATH: process.env.PATH })).not.toContain('"--provenance"');
  }, 120_000);

  const verify = async (label: "v1" | "v2", registry: PublishFetch, verifier = fakeVerifier()) => {
    const v = (await verifyRelease({ cwd: r.dir, ref: label })) as ReleaseVerification;
    expect(v.status).toBe("unsigned");
    const sigstore = await verifySigstore({ cwd: r.dir, releaseDigest: releases[label], verifier, fetch: registry, env: {} });
    return { v, sigstore, code: carriedVerification(v, sigstore), verifier };
  };

  test("a release published with provenance verifies by its Sigstore identity, checked against the SHA-512 the registry serves", async () => {
    const registry = fakeRegistry(withProvenance());
    const { v, sigstore, code, verifier } = await verify("v1", registry);
    expect(sigstore).toMatchObject({ status: "verified", reason: "1 Sigstore bundle(s) verified" });
    expect(sigstore.checks).toEqual([
      expect.objectContaining({ name: `${NAME}@${VERSION} provenance`, kind: "npm", attachment: "attestation", status: "verified", identity: IDENTITY, signs: [{ name: `${NAME}@${VERSION}`, digest: `sha512:${SHA512.toString("hex")}` }] }),
    ]);
    expect(verifier.calls).toEqual([{ digest: `sha512:${SHA512.toString("hex")}`, identity: IDENTITY }]);
    expect(registry.urls).toEqual([`${REGISTRY}/-/npm/v1/attestations/@acme%2fcore@${VERSION}`, `${REGISTRY}/@acme%2fcore/${VERSION}`]);
    // What `release verify --sigstore` exits with: 0, carried by Sigstore.
    expect(code).toBeNull();
    expect(v).toMatchObject({ carriedBy: "sigstore", reason: "no cut is ssh-signed; the release is verified by its Sigstore identity" });
  });

  test("provenance over other bytes than the registry serves fails, and the release stays unsigned", async () => {
    const { v, sigstore, code } = await verify("v1", fakeRegistry(withProvenance(createHash("sha512").update("other bytes").digest())));
    expect(sigstore.status).toBe("failed");
    expect(sigstore.checks[0]).toMatchObject({ status: "failed", reason: "no matching attestation" });
    expect(code).toBe("release-unsigned");
    expect(v.carriedBy).toBeNull();
  });

  test("the same release without provenance ends release-unsigned, and the registry is not asked", async () => {
    const registry = fakeRegistry(withProvenance());
    const { v, sigstore, code } = await verify("v2", registry);
    expect(sigstore).toMatchObject({ status: "none", checks: [] });
    expect(registry.urls).toEqual([]);
    expect(code).toBe("release-unsigned");
    expect(v.carriedBy).toBeNull();
  });

  test("a registry that holds no provenance for the version leaves nothing to carry it", async () => {
    const { sigstore, code } = await verify("v1", fakeRegistry(null));
    expect(sigstore).toMatchObject({ status: "none", checks: [] });
    expect(code).toBe("release-unsigned");
  });

  test("a cached 200 OK text body on the attestations path is no attestation, never a pass", async () => {
    const verifier = fakeVerifier();
    const { v, sigstore, code } = await verify("v1", fakeRegistry({ status: 200, type: "text/plain", body: "OK" }), verifier);
    expect(sigstore.status).toBe("failed");
    expect(sigstore.checks).toEqual([expect.objectContaining({ name: `${NAME}@${VERSION} provenance`, status: "unchecked", reason: expect.stringContaining('"OK"') })]);
    expect(verifier.calls).toEqual([]);
    expect(code).toBe("release-unsigned");
    expect(v.carriedBy).toBeNull();
  });
});

describe("cosign's check of an npm package's provenance", () => {
  test("passes the SHA-512 with --digestAlg sha512, and a sha256 digest as before", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-npm-cosign-"));
    try {
      const log = join(dir, "cosign.log");
      const cosign = join(dir, "cosign");
      writeFileSync(cosign, `#!/bin/sh\nif [ "$1" = version ]; then echo "GitVersion:    v3.0.2"; exit 0; fi\necho "$@" >> "${log}"\n`);
      chmodSync(cosign, 0o755);
      const verifier = cosignVerifier({ PATH: process.env.PATH }, cosign);
      expect(await verifier.verifyBlobAttestation(new Uint8Array(Buffer.from("{}")), `sha512:${SHA512.toString("hex")}`, SLSA_PROVENANCE_PREDICATE, IDENTITY)).toBeNull();
      expect(await verifier.verifyBlobAttestation(new Uint8Array(Buffer.from("{}")), `sha256:${"ab".repeat(32)}`, SLSA_PROVENANCE_PREDICATE, IDENTITY)).toBeNull();
      const [npm, file] = readFileSync(log, "utf-8").trim().split("\n");
      expect(npm).toContain(`--type slsaprovenance1 --digest ${SHA512.toString("hex")} --digestAlg sha512`);
      expect(file).toContain(`--digest ${"ab".repeat(32)} --digestAlg sha256`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
