/**
 * #5458: the modes of `release.signing` besides keyless public Sigstore.
 * Everything here runs against fakes: a fake cosign (a shell script that
 * records its arguments and writes a bundle), a local key file, an injected
 * signer and verifier, and a fake forge. Nothing reaches a KMS, Fulcio or
 * Rekor.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { createRedactor } from "./publish-credentials";
import {
  COSIGN_PASSWORD_ENV,
  HOST_BUILD_TYPE,
  SIGSTORE_BUNDLE_MEDIA_TYPE,
  SLSA_BUNDLE_FILE,
  SLSA_PROVENANCE_PREDICATE,
  cosignSigner,
  cosignSigningEnv,
  cosignSigningFlags,
  cosignVerifyFlags,
  resolveSigning,
  signingConfigProblems,
  signingReadiness,
  signingStepVariables,
  type InTotoStatement,
  type Signer,
  type SigningIdentity,
  type SigstoreVerifier,
} from "./publish-signing";
import { SigningConfigSchema } from "./signing-config";
import { preparePublish, publishContext, runPublish } from "./release-publish";
import { releaseDoctor } from "./release-doctor";
import { verifySigstore } from "./release-verify";
import { cutRelease } from "./release-cut";
import type { ReleaseArtifact } from "./release-store";
import type { PublishDeclaration } from "./publish-declaration";
import type { PublishFetch } from "./release-publish";
import { renderReleaseWorkflow } from "../workspace/release-workflow";
import { TestRepo } from "../workspace/trust/test-repo";
import type { CompiledTarget, TargetCompiler } from "../components/release-compile";
import { startFakeForge, writeLockfile } from "./__fixtures__/publish-fakes";

const dirs: string[] = [];
const repos: TestRepo[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  for (const r of repos) rmSync(dirname(r.dir), { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "chant-signing-modes-"));
  dirs.push(d);
  return d;
};
const sha = (b: Uint8Array | string) => `sha256:${createHash("sha256").update(b).digest("hex")}`;
const none = new Set<never>();
const sc = new Set(["supply-chain" as const]);

/** A cosign stand-in: `version` prints a v3 GitVersion; anything else records its arguments and the password it got, and writes the bundle `--bundle` names. */
function fakeCosign(): { path: string; calls: () => Array<{ args: string[]; password: string | null }> } {
  const dir = temp();
  const log = join(dir, "calls.jsonl");
  const path = join(dir, "cosign");
  writeFileSync(
    path,
    [
      "#!/usr/bin/env node",
      'const fs = require("fs");',
      "const args = process.argv.slice(2);",
      'if (args[0] === "version") { console.log("GitVersion:    v3.0.2"); process.exit(0); }',
      `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, password: process.env.COSIGN_PASSWORD ?? null }) + "\\n");`,
      'const i = args.indexOf("--bundle");',
      'if (i >= 0 && !args[0].startsWith("verify")) fs.writeFileSync(args[i + 1], JSON.stringify({ mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json", fake: true }));',
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return {
    path,
    calls: () =>
      existsSync(log)
        ? readFileSync(log, "utf-8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l) as { args: string[]; password: string | null })
        : [],
  };
}

/** A signer whose bundle names what it signed. */
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

/** A verifier that reads the fake bundles and records what it was asked to verify against. */
function fakeVerifier(): SigstoreVerifier & { against: SigningIdentity[] } {
  const against: SigningIdentity[] = [];
  const read = (b: Uint8Array) => JSON.parse(Buffer.from(b).toString("utf-8")) as { blob?: string; statement?: InTotoStatement };
  return {
    name: "fake-cosign",
    against,
    unavailable: () => null,
    verifyBlob: async (b, digest, id) => {
      against.push(id);
      return read(b).blob === digest ? null : "artifact does not match digest";
    },
    verifyBlobAttestation: async (b, digest, pt, id) => {
      against.push(id);
      const s = read(b).statement;
      return s?.predicateType === pt && s.subject.some((x) => `sha256:${x.digest.sha256}` === digest) ? null : "no matching attestation";
    },
    verifyImage: async () => null,
    verifyImageAttestation: async () => null,
  };
}

describe("release.signing's shape (#5458)", () => {
  test("a key picks key mode, with its password variable defaulting to COSIGN_PASSWORD", () => {
    expect(resolveSigning({ key: "cosign.key", publicKey: "cosign.pub" }, none)).toMatchObject({ on: true, mode: "key", key: "cosign.key", publicKey: "cosign.pub", passwordEnv: COSIGN_PASSWORD_ENV, tlog: true });
    expect(resolveSigning({ key: "env://RELEASE_KEY", publicKey: "cosign.pub", passwordEnv: "RELEASE_KEY_PASSWORD", rekor: false }, none)).toMatchObject({ mode: "key", passwordEnv: "RELEASE_KEY_PASSWORD", tlog: false });
    expect(resolveSigning(true, none)).toMatchObject({ mode: "keyless", tlog: true });
    expect(resolveSigning(undefined, sc)).toMatchObject({ mode: "keyless" });
  });

  test("the schema refuses mixed modes and a key without its public key", () => {
    expect(SigningConfigSchema.safeParse({ key: "k", publicKey: "p" }).success).toBe(true);
    expect(signingConfigProblems({ key: "k" })).toEqual([expect.stringContaining("publicKey")]);
    expect(signingConfigProblems({ key: "k", publicKey: "p", identity: "^x" })).toEqual([expect.stringContaining("keyless certificate")]);
    expect(signingConfigProblems({ rekor: false })).toEqual([expect.stringContaining("transparency log")]);
    expect(signingConfigProblems({ passwordEnv: "P" })).toEqual([expect.stringContaining("no key")]);
    expect(signingConfigProblems({ key: "env://not a name", publicKey: "p" })).toEqual([expect.stringContaining("env://NAME")]);
    expect(SigningConfigSchema.safeParse({ key: "k" }).success).toBe(false);
    expect(SigningConfigSchema.safeParse({ fulcio: "https://x" }).success).toBe(false);
  });

  test("the signing step's variables are the key's variable and its password", () => {
    expect(signingStepVariables(resolveSigning({ key: "env://RELEASE_KEY", publicKey: "p" }, none))).toEqual(["RELEASE_KEY", "COSIGN_PASSWORD"]);
    expect(signingStepVariables(resolveSigning({ key: "cosign.key", publicKey: "p", passwordEnv: "PW" }, none))).toEqual(["PW"]);
    expect(signingStepVariables(resolveSigning(true, none))).toEqual([]);
  });
});

describe("cosign in key mode", () => {
  test("signs with --key, gets the password as COSIGN_PASSWORD, and leaves the log out only under rekor: false", () => {
    expect(cosignSigningFlags({ mode: "key", key: "/abs/cosign.key" })).toEqual(["--key", "/abs/cosign.key"]);
    expect(cosignSigningFlags({ mode: "key", key: "env://K", tlog: false })).toEqual(["--key", "env://K", "--use-signing-config=false", "--tlog-upload=false"]);
    expect(cosignSigningFlags({ mode: "keyless" })).toEqual([]);
    expect(cosignSigningEnv({ PW: "s3cret" }, { mode: "key", passwordEnv: "PW" })).toMatchObject({ COSIGN_PASSWORD: "s3cret" });
    expect(cosignSigningEnv({ PW: "s3cret" }, { mode: "keyless" })).not.toHaveProperty("COSIGN_PASSWORD");
    expect(cosignVerifyFlags({ key: "/abs/cosign.pub" })).toEqual(["--key", "/abs/cosign.pub"]);
    expect(cosignVerifyFlags({ key: "/abs/cosign.pub" }, { tlog: false })).toEqual(["--key", "/abs/cosign.pub", "--insecure-ignore-tlog=true"]);
    expect(cosignVerifyFlags({ issuer: "https://i", identity: "^x" })).toEqual(["--certificate-identity-regexp", "^x", "--certificate-oidc-issuer", "https://i"]);
  });

  test("the cosign signer runs sign-blob and attest-blob with the key, and the password reaches cosign alone", async () => {
    const cosign = fakeCosign();
    const env = { PATH: process.env.PATH, RELEASE_PW: "pw-key-1" };
    const signer = cosignSigner(env, createRedactor(env), cosign.path, { mode: "key", key: "/keys/cosign.key", passwordEnv: "RELEASE_PW" });
    expect(signer.unavailable()).toBeNull();
    expect(signer.name).toBe("cosign v3.0.2");
    await signer.signBlob(new Uint8Array(Buffer.from("x")), "x");
    await signer.signStatement({ _type: "t", subject: [], predicateType: SLSA_PROVENANCE_PREDICATE, predicate: {} });
    const calls = cosign.calls();
    expect(calls.map((c) => c.args.slice(0, 5))).toEqual([
      ["sign-blob", "--yes", "--new-bundle-format=true", "--key", "/keys/cosign.key"],
      ["attest-blob", "--yes", "--new-bundle-format=true", "--key", "/keys/cosign.key"],
    ]);
    expect(calls.map((c) => c.password)).toEqual(["pw-key-1", "pw-key-1"]);
    // The run's own environment is left as it was.
    expect(env).not.toHaveProperty("COSIGN_PASSWORD");
  });

  test("readiness names what is missing: the key's variable, the key file, the password, the public key", () => {
    const dir = temp();
    const setting = resolveSigning({ key: "env://RELEASE_KEY", publicKey: "cosign.pub" }, none);
    expect(signingReadiness(setting, {}, dir)).toMatchObject({ code: "publish-signing-key-missing", reason: expect.stringContaining("RELEASE_KEY") });
    expect(signingReadiness(setting, { RELEASE_KEY: "pem" }, dir)).toMatchObject({ reason: expect.stringContaining("COSIGN_PASSWORD") });
    expect(signingReadiness(setting, { RELEASE_KEY: "pem", COSIGN_PASSWORD: "" }, dir)).toMatchObject({ reason: expect.stringContaining("cosign.pub") });
    writeFileSync(join(dir, "cosign.pub"), "-----BEGIN PUBLIC KEY-----\n");
    expect(signingReadiness(setting, { RELEASE_KEY: "pem", COSIGN_PASSWORD: "" }, dir)).toBeNull();
    const file = resolveSigning({ key: "cosign.key", publicKey: "cosign.pub" }, none);
    expect(signingReadiness(file, { COSIGN_PASSWORD: "" }, dir)).toMatchObject({ reason: expect.stringContaining("cosign.key, which is not there") });
  });
});

describe("a publish signed with a key, end to end", () => {
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
  beforeAll(async () => {
    r = new TestRepo("signing-key");
    repos.push(r);
    r.write(
      "chant.config.ts",
      `export default { environments: ["dev"], release: { signing: { key: "env://RELEASE_KEY", publicKey: "keys/cosign.pub", rekor: false }, publish: [{ type: "forge", forge: "github", repo: "acme/api", api: "${API}", assets: ["dist/api.tar.gz"] }] } };\n`,
    );
    r.write("api.component.ts", "export const api = {};\n");
    r.write(".gitignore", "node_modules\n");
    r.write("dist/api.tar.gz", "asset bytes");
    r.write("keys/cosign.pub", "-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----\n");
    writeLockfile(r.dir);
    const head = r.commit("init");
    r.git(["tag", `ci/green/${head}`]);
    await cutRelease({ cwd: r.dir, compiler, label: "v3", actor: "alice", env: {}, now: () => new Date("2026-11-21T10:00:00.000Z") });
  }, 120_000);

  test("with no CI OIDC token, --require-provenance is met by the key-signed statement, which names the workstation", async () => {
    const forge = startFakeForge("github", API, "acme/api");
    const signer = fakeSigner();
    const env = { PATH: process.env.PATH, GITHUB_TOKEN: "ghs_key", RELEASE_KEY: "pem", COSIGN_PASSWORD: "" };
    const plan = await preparePublish({ cwd: r.dir, ref: "v3", env, requireProvenance: true, deps: { fetch: forge.fetch, signer } });
    if ("refusal" in plan) throw new Error(plan.refusal.message);
    expect(plan.provenance.oidc).toBe(false);
    expect(plan.warning).toBeNull();
    expect(plan.signing).toMatchObject({ identity: { key: "keys/cosign.pub" }, mode: "key" });
    const ctx = publishContext(plan, { cwd: r.dir, env, log: () => undefined });
    await runPublish({ cwd: r.dir, release: plan.release, label: plan.label, targets: plan.targets, ctx });
    const assets = forge.releases[0]!.assets;
    const slsa = JSON.parse(Buffer.from(assets.find((a) => a.name === SLSA_BUNDLE_FILE)!.bytes).toString("utf-8")) as { statement: InTotoStatement };
    expect(slsa.statement.predicate).toMatchObject({ buildDefinition: { buildType: HOST_BUILD_TYPE, internalParameters: { host: { runner: "workstation" } } } });
    expect(JSON.stringify(slsa.statement)).not.toContain("github.com");

    // release verify checks each bundle with the public key from the member.
    const download = join(dirname(r.dir), "download-key");
    mkdirSync(download);
    for (const a of assets) writeFileSync(join(download, a.name), a.bytes);
    const verifier = fakeVerifier();
    const ok = await verifySigstore({ cwd: r.dir, releaseDigest: plan.release.releaseDigest, assetsDir: download, verifier });
    expect(ok.status).toBe("verified");
    expect(new Set(verifier.against.map((a) => JSON.stringify(a)))).toEqual(new Set([JSON.stringify({ key: join(r.dir, "keys/cosign.pub") })]));
    expect(ok.checks[0]!.identity).toEqual({ key: join(r.dir, "keys/cosign.pub") });
  });

  test("the refusal names what the key mode is missing, and nothing is sent", async () => {
    const forge = startFakeForge("github", API, "acme/api");
    const signer = fakeSigner();
    const noPassword = await preparePublish({ cwd: r.dir, ref: "v3", env: { PATH: process.env.PATH, RELEASE_KEY: "pem" }, requireProvenance: true, deps: { fetch: forge.fetch, signer } });
    expect(noPassword).toMatchObject({ refusal: { code: "publish-provenance-missing", message: expect.stringContaining("COSIGN_PASSWORD") } });
    const noKey = await preparePublish({ cwd: r.dir, ref: "v3", env: { PATH: process.env.PATH, COSIGN_PASSWORD: "" }, deps: { fetch: forge.fetch, signer } });
    expect(noKey).toMatchObject({ refusal: { code: "publish-signing-key-missing", message: expect.stringContaining("RELEASE_KEY") } });
    expect(forge.calls).toEqual([]);
    expect(signer.calls).toEqual([]);
  });
});

describe("the doctor in key mode", () => {
  const forgeDecl = { type: "forge", forge: "github", repo: "acme/app", assets: [] } as unknown as PublishDeclaration;
  const fetch = (async () => new Response("{}", { status: 404 })) as unknown as PublishFetch;
  const cosign = { name: "cosign v3.0.2", unavailable: () => null };
  const doctor = (env: NodeJS.ProcessEnv, from?: "cut") =>
    releaseDoctor({ cwd: temp(), publish: [forgeDecl], env, releaseWorkflow: null, signing: { key: "env://RELEASE_KEY", publicKey: "cosign.pub" }, ...(from ? { from } : {}), deps: { fetch, signer: cosign } }).then((r) => r.targets.find((t) => t.kind === "signing")!);

  test("fails in CI when the key's variable is missing, and is unknown in the cut job, which never holds it", async () => {
    const ci = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "acme/app" };
    expect((await doctor(ci)).checks.map((c) => [c.check, c.status])).toEqual([["signing-key", "fail"], ["signing-cosign", "ok"]]);
    expect((await doctor(ci, "cut")).checks.map((c) => [c.check, c.status])).toEqual([["signing-key", "unknown"], ["signing-cosign", "ok"]]);
  });
});

describe("the release workflow in key mode", () => {
  const job = (text: string, name: string) => text.split(/\n(?=  [a-z][\w-]*:\n)/).find((j) => j.startsWith(`  ${name}:`)) ?? "";

  test("the key's variables reach the publish step alone, from the repository's secrets", () => {
    const text = renderReleaseWorkflow({ forge: "github", groups: sc, signing: true, signingEnv: ["RELEASE_KEY", "COSIGN_PASSWORD"], pipeline: { trigger: "dispatch" }, publish: [{ type: "forge", forge: "github" }] });
    const publish = job(text, "publish");
    expect(publish).toContain('release publish "$CHANT_RELEASE_LABEL" --require-provenance --yes\n        env:\n          RELEASE_KEY: ${{ secrets.RELEASE_KEY }}\n          COSIGN_PASSWORD: ${{ secrets.COSIGN_PASSWORD }}');
    expect(publish.match(/secrets\.RELEASE_KEY/g)).toHaveLength(1);
    expect(job(text, "cut")).not.toContain("RELEASE_KEY");
    const tag = renderReleaseWorkflow({ forge: "forgejo", groups: sc, signing: true, signingEnv: ["RELEASE_KEY"], publish: [{ type: "forge", forge: "forgejo" }] });
    expect(tag).toMatch(/release publish .*\n {8}env:\n {10}RELEASE_KEY: \$\{\{ secrets\.RELEASE_KEY \}\}/);
    // A variable release.workflow.env sets for the job is left there.
    const own = renderReleaseWorkflow({ forge: "github", groups: sc, signing: true, signingEnv: ["RELEASE_KEY"], pipeline: { env: { RELEASE_KEY: "${{ secrets.OTHER }}" } } });
    expect(own).not.toContain("secrets.RELEASE_KEY");
    // GitLab hands CI/CD variables to every job, so the file names none.
    expect(renderReleaseWorkflow({ forge: "gitlab", groups: sc, signing: true, signingEnv: ["RELEASE_KEY"] })).not.toContain("RELEASE_KEY");
  });

  test("a train's publish step gets them too", () => {
    const text = renderReleaseWorkflow({ forge: "github", groups: sc, signing: true, signingEnv: ["RELEASE_KEY"], train: { env: "prod" }, pipeline: { trigger: "dispatch" } });
    expect(job(text, "publish")).toMatch(/workspace train publish prod "\$CHANT_RELEASE_TRAIN" --require-provenance --yes\n {8}env:\n {10}RELEASE_KEY: \$\{\{ secrets\.RELEASE_KEY \}\}/);
    expect(job(text, "cut")).not.toContain("RELEASE_KEY");
  });
});
