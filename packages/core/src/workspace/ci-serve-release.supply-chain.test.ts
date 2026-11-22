/**
 * #5462, epic #5452: a release `ci serve --release` serves gets what a
 * rendered workflow gives one under `supply-chain`, through the same code:
 *
 * 1. a refusal for a `FROM` not pinned by digest, in the `release images`
 *    step the host's job holds, before anything is built;
 * 2. the scan before the stage, which stops the publish before anything
 *    reaches the registry;
 * 3. the image's SBOM made from its layers, which lists its OS packages;
 * 4. a key-signed SLSA statement that names the host's runner key as its
 *    builder, which meets `--require-provenance` with no CI OIDC token.
 *
 * The host job is the one rendered for the repository, its publish step
 * runs with the variables the host gives it, and that step runs the
 * library the `release publish` command runs. Fakes only: a registry fake,
 * a fake scanner, a fake signer and a local key. Nothing leaves the machine.
 */

import { generateKeyPairSync } from "node:crypto";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cutRelease } from "../lifecycle/release-cut";
import { preparePublish, publishContext, runPublish, type PublishRefusal } from "../lifecycle/release-publish";
import { readPublishRecords } from "../lifecycle/publish-record";
import { buildReleaseImages } from "../lifecycle/release-images";
import { CI_SERVE_BUILDER, HOST_BUILD_TYPE, SIGSTORE_BUNDLE_MEDIA_TYPE, SLSA_PROVENANCE_PREDICATE, type InTotoStatement, type Signer } from "../lifecycle/publish-signing";
import { resolveRelease, type ReleaseArtifact } from "../lifecycle/release-store";
import type { CompiledTarget, TargetCompiler } from "../components/release-compile";
import { startFakeRegistry, writeOciLayout } from "../lifecycle/__fixtures__/publish-fakes";
import { fakeReleaseScanner } from "../lifecycle/__fixtures__/scan-fakes";
import { refuseUnpinnedBases } from "../cli/handlers/release";
import { hostReleaseJob, hostSigningRefusal, runHostJob, type HostStepRunner } from "./ci-serve-release";
import { releaseWorkflowInputAt } from "./release-workflow";
import { parseCiSecrets } from "./ci-secrets";
import { loadRunnerKey, sshFingerprint } from "./trust/dsse";
import { TestRepo } from "./trust/test-repo";

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

const WORKSPACE = JSON.stringify({ name: "acme", schema: 1, members: [{ name: "root", dir: ".", kind: "other", because: "the served release fixture" }], security: ["supply-chain"] }, null, 2);
const TOOLS = { CHANT_COSIGN: "/host/tools/cosign", CHANT_GRYPE: "/host/tools/grype", CHANT_SYFT: "/host/tools/syft" };

/** The host's runner key and its fingerprint. */
const runnerKey = (() => {
  const pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return { pem, fingerprint: sshFingerprint(loadRunnerKey(pem).publicKey) };
})();

/** A signer that keeps the statements it signed. */
function fakeSigner(): Signer & { statements: InTotoStatement[]; calls: string[] } {
  const statements: InTotoStatement[] = [];
  const calls: string[] = [];
  const bundle = (v: object) => new Uint8Array(Buffer.from(JSON.stringify({ mediaType: SIGSTORE_BUNDLE_MEDIA_TYPE, ...v })));
  return {
    name: "fake-cosign",
    statements,
    calls,
    unavailable: () => null,
    signBlob: async (_bytes, name) => (calls.push(`blob ${name}`), bundle({ blob: name })),
    signStatement: async (s) => (calls.push(`statement ${s.predicateType}`), statements.push(s), bundle({ statement: s })),
  };
}

describe("a release served by ci serve --release under supply-chain (#5462)", () => {
  let r: TestRepo;
  let reg: Awaited<ReturnType<typeof startFakeRegistry>>;
  let head: string;
  beforeAll(async () => {
    reg = await startFakeRegistry({ username: "robot", password: "pw-served-1", token: "tok-served-1" });
    r = new TestRepo("serve-release-sc");
    repos.push(r);
    r.write("chant.workspace.json", WORKSPACE);
    r.write(
      "chant.config.ts",
      `export default { environments: ["dev"], release: { signing: { key: "env://RELEASE_KEY", publicKey: "keys/cosign.pub", rekor: false }, publish: [{ type: "oci", image: "image", repository: "${reg.host}/acme/api" }] } };\n`,
    );
    r.write("api.component.ts", "export const api = {};\n");
    r.write("keys/cosign.pub", "-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----\n");
    r.write("package-lock.json", JSON.stringify({ name: "acme", lockfileVersion: 3, packages: { "": { name: "acme" }, "node_modules/left-pad": { version: "1.3.1" } } }, null, 2));
    writeOciLayout(join(r.dir, "image"));
    head = r.commit("init");
    r.git(["tag", `ci/green/${head}`]);
    await cutRelease({ cwd: r.dir, compiler, label: "v1", actor: "alice", env: {}, now: () => new Date("2026-11-21T10:00:00.000Z") });
  }, 120_000);
  afterAll(async () => {
    await reg?.close();
  });

  /** Run the host's publish job for release/v1: every step but the publish is recorded and passes; the publish runs the library `release publish` runs, with the step's variables. */
  async function serve(scanner: ReturnType<typeof fakeReleaseScanner>, signer: ReturnType<typeof fakeSigner>) {
    const read = await releaseWorkflowInputAt(r.dir);
    expect(hostSigningRefusal(read)).toBeNull();
    expect([read.signs, read.scans]).toEqual([true, true]);
    const job = hostReleaseJob(read, TOOLS);
    const ran: string[] = [];
    const refusals: PublishRefusal[] = [];
    const errors: unknown[] = [];
    const envs: Record<string, string>[] = [];
    const runStep: HostStepRunner = async ({ script, env }) => {
      ran.push(script);
      if (!/\brelease publish\b/.test(script)) return 0;
      envs.push(env);
      const label = env.GITHUB_REF_NAME!.replace(/^release\//, "");
      const plan = await preparePublish({ cwd: r.dir, ref: label, env, requireProvenance: script.includes("--require-provenance"), deps: { signer, releaseScanner: scanner } });
      if ("refusal" in plan) return (refusals.push(plan.refusal), 1);
      try {
        await runPublish({ cwd: r.dir, release: plan.release, label: plan.label, targets: plan.targets, ctx: publishContext(plan, { cwd: r.dir, env, log: () => undefined }) });
        return 0;
      } catch (err) {
        return (errors.push(err), 1);
      }
    };
    const secrets = { file: "host.env", ...parseCiSecrets("OCI_USERNAME=robot\nOCI_PASSWORD=pw-served-1\nRELEASE_KEY=pem-served\nCOSIGN_PASSWORD=\n", "host.env") };
    const result = await runHostJob(job, {
      top: r.dir,
      commit: head,
      tag: "release/v1",
      runId: "chant-serve-1-release-test",
      fingerprint: runnerKey.fingerprint,
      // The host's own environment says it is GitHub Actions; the publish must not take it for one.
      hostEnv: { PATH: process.env.PATH, GITHUB_ACTIONS: "true", ACTIONS_ID_TOKEN_REQUEST_URL: "https://x", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "t" },
      runnerTemp: join(dirname(r.dir), `runner-temp-${Date.now()}`),
      secrets,
      runStep,
    });
    return { job, result, ran, refusals, errors, envs };
  }

  test("2. the scan before the stage stops the publish, and nothing reaches the registry or the signer", async () => {
    const signer = fakeSigner();
    const served = await serve(fakeReleaseScanner(), signer);
    expect(served.result).toMatchObject({ status: "fail" });
    expect(served.refusals).toEqual([]);
    expect(served.errors[0]).toMatchObject({ code: "publish-scan-failed", step: "scan" });
    expect((served.errors[0] as Error).message).toContain("CVE-2026-50002 (critical) in debian/openssl 3.0.11-1");
    expect(reg.requests).toEqual([]);
    expect(signer.calls).toEqual([]);
    // The publish step ran with the host's variables: no forge run variables, no OIDC, the runner key's fingerprint.
    expect(served.envs[0]).not.toHaveProperty("GITHUB_ACTIONS");
    expect(served.envs[0]).not.toHaveProperty("ACTIONS_ID_TOKEN_REQUEST_URL");
    expect(served.envs[0]).toMatchObject({ CHANT_RELEASE_RUNNER_KEY_FINGERPRINT: runnerKey.fingerprint, CHANT_COSIGN: TOOLS.CHANT_COSIGN, CHANT_GRYPE: TOOLS.CHANT_GRYPE });
  });

  test("3 and 4. a clean image publishes with the SBOM of its layers, and the key-signed SLSA statement names the host's runner key", async () => {
    const signer = fakeSigner();
    const served = await serve(fakeReleaseScanner({ image: ["pkg:deb/debian/openssl@3.0.15-1", "pkg:deb/debian/zlib@1.2.13"] }), signer);
    expect(served.refusals).toEqual([]);
    expect(served.errors).toEqual([]);
    expect(served.result.status).toBe("ok");
    expect(served.ran.at(-1)).toMatch(/ release publish "\$\{GITHUB_REF_NAME#release\/\}" --require-provenance --yes$/);

    // 3: the SBOM pushed beside the image is the one made from its layers, listing the OS packages.
    const sboms = [...reg.blobs.values()].map((b) => b.toString("utf-8")).filter((t) => t.includes('"spdxVersion"'));
    expect(sboms.some((t) => t.includes("pkg:deb/debian/openssl@3.0.15-1") && t.includes("pkg:deb/debian/zlib@1.2.13"))).toBe(true);

    // 4: signed with the key, and the statement names this host as the builder.
    const slsa = signer.statements.find((s) => s.predicateType === SLSA_PROVENANCE_PREDICATE)!;
    expect(slsa.predicate).toMatchObject({
      buildDefinition: { buildType: HOST_BUILD_TYPE, internalParameters: { host: { runner: "ci-serve", runnerKey: runnerKey.fingerprint } } },
      runDetails: { builder: { id: `${CI_SERVE_BUILDER}${encodeURIComponent(runnerKey.fingerprint)}` } },
    });
    expect(signer.calls.some((c) => c.startsWith("statement"))).toBe(true);

    // The publish record names the runner key and the serve's run.
    const found = await resolveRelease("v1", { cwd: r.dir });
    const records = await readPublishRecords(found!.release.releaseDigest, { cwd: r.dir });
    const revealed = records.filter((l) => l.step === "revealed");
    expect(revealed.length).toBeGreaterThan(0);
    expect(revealed.every((l) => l.runnerKey === runnerKey.fingerprint && l.runId === "chant-serve-1-release-test")).toBe(true);
  });

  test("1. an image built from a FROM not pinned by digest is refused in the job's release images step, before anything is built", async () => {
    const images = new TestRepo("serve-release-images");
    repos.push(images);
    images.write("chant.workspace.json", WORKSPACE);
    images.write("chant.config.ts", `export default { environments: ["dev"], release: { signing: { key: "env://RELEASE_KEY", publicKey: "keys/cosign.pub" }, images: [{ name: "api", dockerfile: "Dockerfile" }], publish: [{ type: "oci", image: "api", repository: "${reg.host}/acme/api" }] } };\n`);
    images.write("Dockerfile", "FROM node:22\nCOPY . /app\n");
    images.commit("init");
    // The host's job builds the images in its own step, the one the rendered workflow holds, before the build and the publish.
    const job = hostReleaseJob(await releaseWorkflowInputAt(images.dir), TOOLS);
    const runs = job.steps.filter((s) => s.run).map((s) => s.run!);
    const at = runs.findIndex((l) => l.includes(' release images "${GITHUB_REF_NAME#release/}"'));
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(runs.findIndex((l) => l.includes("release publish")));
    // That step refuses under supply-chain before it builds, as the cut does: the command and the cut both call refuseUnpinnedBases first.
    const declared = [{ name: "api", dockerfile: "Dockerfile" }];
    const builds: string[] = [];
    const build = async () => {
      await refuseUnpinnedBases(declared, images.dir);
      return buildReleaseImages({ images: declared, cwd: images.dir, sourceDateEpoch: 0, label: "v1", archiveDigest: () => "sha256:0", run: (c) => (builds.push(c), 1) });
    };
    await expect(build()).rejects.toMatchObject({ code: "release-image-base-unpinned", message: expect.stringContaining("api: Dockerfile:1 FROM node:22") });
    expect(builds).toEqual([]);
    // Pinned, the build runs.
    images.write("Dockerfile", `FROM node:22@sha256:${"a".repeat(64)}\nCOPY . /app\n`);
    await expect(build()).rejects.toMatchObject({ code: "release-image-build-failed" });
    expect(builds).toHaveLength(1);
    // Outside supply-chain nothing is refused.
    images.write("chant.workspace.json", JSON.stringify({ name: "acme", schema: 1, members: [{ name: "root", dir: ".", kind: "other", because: "x" }] }));
    images.write("Dockerfile", "FROM node:22\n");
    images.commit("no security groups");
    await expect(refuseUnpinnedBases(declared, images.dir)).resolves.toBeUndefined();
  });
});
