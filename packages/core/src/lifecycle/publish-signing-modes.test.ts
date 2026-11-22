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
  signingIdentity,
  signingReadiness,
  signingStepVariables,
  prepareSigning,
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

describe("kms mode", () => {
  test("a KMS reference picks kms mode, with each scheme's credential variables unless env names them", () => {
    expect(resolveSigning({ kms: "awskms:///alias/release" }, none)).toMatchObject({ mode: "kms", kms: "awskms:///alias/release", env: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"], tlog: true });
    expect(resolveSigning({ kms: "hashivault://release" }, none)).toMatchObject({ env: ["VAULT_ADDR", "VAULT_TOKEN"] });
    expect(resolveSigning({ kms: "azurekms://vault.vault.azure.net/release" }, none)).toMatchObject({ env: ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"] });
    expect(resolveSigning({ kms: "gcpkms://projects/p/locations/l/keyRings/r/cryptoKeys/k", env: ["GOOGLE_APPLICATION_CREDENTIALS"] }, none)).toMatchObject({ env: ["GOOGLE_APPLICATION_CREDENTIALS"] });
    expect(signingStepVariables(resolveSigning({ kms: "hashivault://release" }, none))).toEqual(["VAULT_ADDR", "VAULT_TOKEN"]);
    expect(signingConfigProblems({ kms: "hashivault://release", key: "k", publicKey: "p" })).toContainEqual(expect.stringContaining("name one"));
    expect(signingConfigProblems({ kms: "file:///k" })).toEqual([expect.stringContaining("not a reference cosign takes")]);
    expect(signingConfigProblems({ env: ["X"] })).toEqual([expect.stringContaining("no kms")]);
    expect(signingConfigProblems({ kms: "awskms:///alias/r", passwordEnv: "P" })).toEqual([expect.stringContaining("no key")]);
    expect(signingConfigProblems({ kms: "awskms:///alias/r", rekor: false })).toEqual([]);
  });

  test("the KMS stand-in: cosign signs with --key hashivault://, the credentials come from the run's variables, and readiness names the one missing", async () => {
    const cosign = fakeCosign();
    const setting = resolveSigning({ kms: "hashivault://release" }, none);
    const dir = temp();
    expect(signingReadiness(setting, { VAULT_ADDR: "http://vault.test" }, dir)).toMatchObject({ code: "publish-signing-key-missing", reason: expect.stringContaining("VAULT_TOKEN, which is not set here") });
    expect(signingReadiness(setting, { VAULT_ADDR: "http://vault.test", VAULT_TOKEN: "t" }, dir)).toBeNull();
    const env = { PATH: process.env.PATH, VAULT_ADDR: "http://vault.test", VAULT_TOKEN: "stand-in", CHANT_COSIGN: cosign.path };
    const prepared = (await import("./publish-signing")).prepareSigning(setting, { env, cwd: dir, redactor: createRedactor(env) });
    if ("refusal" in prepared) throw new Error(prepared.refusal.reason);
    expect(prepared.context).toMatchObject({ identity: { key: "hashivault://release" }, mode: "kms" });
    await prepared.context.signer.signBlob(new Uint8Array(Buffer.from("x")), "x");
    const [call] = cosign.calls();
    expect(call!.args.slice(0, 5)).toEqual(["sign-blob", "--yes", "--new-bundle-format=true", "--key", "hashivault://release"]);
    // No password is made up for a KMS key.
    expect(call!.password).toBeNull();
  });

  test("the doctor names the missing credential, and the cut job reports it unknown", async () => {
    const forgeDecl = { type: "forge", forge: "github", repo: "acme/app", assets: [] } as unknown as PublishDeclaration;
    const fetch = (async () => new Response("{}", { status: 404 })) as unknown as PublishFetch;
    const run = (from?: "cut") =>
      releaseDoctor({ cwd: temp(), publish: [forgeDecl], env: { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "acme/app", VAULT_ADDR: "http://vault.test" }, releaseWorkflow: null, signing: { kms: "hashivault://release" }, ...(from ? { from } : {}), deps: { fetch, signer: { name: "cosign", unavailable: () => null } } }).then((r) => r.targets.find((t) => t.kind === "signing")!.checks[0]!);
    expect(await run()).toMatchObject({ check: "signing-key", status: "fail", message: expect.stringContaining("VAULT_TOKEN") });
    expect((await run("cut")).status).toBe("unknown");
  });

  test("the KMS credentials reach the publish step alone, in a single release and a train", () => {
    const job = (text: string, name: string) => text.split(/\n(?=  [a-z][\w-]*:\n)/).find((j) => j.startsWith(`  ${name}:`)) ?? "";
    const signingEnv = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"];
    for (const input of [{ pipeline: { trigger: "dispatch" as const } }, { pipeline: { trigger: "dispatch" as const }, train: { env: "prod" } }]) {
      const text = renderReleaseWorkflow({ forge: "github", groups: sc, signing: true, signingEnv, publish: [{ type: "oci" }], ...input });
      const publish = job(text, "publish");
      for (const v of signingEnv) {
        expect(publish).toContain(`          ${v}: \${{ secrets.${v} }}`);
        expect(text.match(new RegExp(`secrets\\.${v}\\b`, "g"))).toHaveLength(1);
      }
      expect(job(text, "cut")).not.toContain("AWS_");
      expect(job(text, "gate")).not.toContain("AWS_");
    }
  });
});

describe("a private Fulcio and Rekor", () => {
  const FULCIO = "https://fulcio.sigstore.test";
  const REKOR = "https://rekor.sigstore.test";

  test("the config names the instance and its trusted root, and refuses a private service without one", () => {
    expect(resolveSigning({ fulcio: FULCIO, rekor: REKOR, trustRoot: "sigstore/trusted_root.json" }, none)).toMatchObject({ mode: "keyless", fulcio: FULCIO, rekor: REKOR, trustRoot: "sigstore/trusted_root.json", tlog: true });
    expect(signingConfigProblems({ fulcio: FULCIO })).toEqual([expect.stringContaining("needs trustRoot")]);
    expect(signingConfigProblems({ rekor: "rekor.internal" })).toEqual([expect.stringContaining("not an http(s) URL"), expect.stringContaining("needs trustRoot")]);
    expect(signingConfigProblems({ key: "k", publicKey: "p", fulcio: FULCIO, trustRoot: "t" })).toEqual([expect.stringContaining("fulcio issues keyless certificates")]);
    expect(signingConfigProblems({ kms: "hashivault://k", rekor: REKOR, trustRoot: "t" })).toEqual([]);
    expect(signingConfigProblems({ trustRoot: "t" })).toEqual([]);
  });

  test("cosign signs against the instance, with its own signing config off, and verifies against the trusted root", () => {
    expect(cosignSigningFlags({ mode: "keyless", fulcio: FULCIO, rekor: REKOR, trustRoot: "/m/trusted_root.json" })).toEqual(["--use-signing-config=false", "--fulcio-url", FULCIO, "--rekor-url", REKOR, "--trusted-root", "/m/trusted_root.json"]);
    // A key signs with no Fulcio, and logs to the private Rekor.
    expect(cosignSigningFlags({ mode: "kms", key: "hashivault://k", fulcio: FULCIO, rekor: REKOR, trustRoot: "/t" })).toEqual(["--key", "hashivault://k", "--use-signing-config=false", "--rekor-url", REKOR, "--trusted-root", "/t"]);
    expect(cosignVerifyFlags({ issuer: "https://i", identity: "^x" }, { trustRoot: "/m/trusted_root.json" })).toEqual(["--certificate-identity-regexp", "^x", "--certificate-oidc-issuer", "https://i", "--trusted-root", "/m/trusted_root.json"]);
  });

  test("a missing trusted root is refused before cosign runs", () => {
    const setting = resolveSigning({ fulcio: FULCIO, rekor: REKOR, trustRoot: "sigstore/trusted_root.json" }, none);
    expect(signingReadiness(setting, {}, temp())).toMatchObject({ code: "publish-signing-trust-root-missing" });
  });

  const compiler: TargetCompiler = {
    async compile(env): Promise<CompiledTarget> {
      return { env, params: [], components: ["api"], buildSteps: {}, buildInputs: {}, componentFiles: { api: "api.component.ts" }, templates: [{ component: "api", path: "dist/api.json", content: `{"env":"${env}"}\n` }] };
    },
    async buildArtifacts(): Promise<ReleaseArtifact[]> {
      return [];
    },
  };
  const API = "https://api.github.test";
  const GITHUB_ENV = {
    GITHUB_ACTIONS: "true",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.test",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "id-request-token",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "acme/api",
    GITHUB_WORKFLOW_REF: "acme/api/.github/workflows/chant-release.yml@refs/tags/release/v4",
    GITHUB_REF: "refs/tags/release/v4",
  };
  let r: TestRepo;
  beforeAll(async () => {
    r = new TestRepo("signing-private");
    repos.push(r);
    r.write(
      "chant.config.ts",
      `export default { environments: ["dev"], release: { signing: { fulcio: "${FULCIO}", rekor: "${REKOR}", trustRoot: "sigstore/trusted_root.json" }, publish: [{ type: "forge", forge: "github", repo: "acme/api", api: "${API}", assets: ["dist/api.tar.gz"] }] } };\n`,
    );
    r.write("api.component.ts", "export const api = {};\n");
    r.write(".gitignore", "node_modules\n");
    r.write("dist/api.tar.gz", "asset bytes");
    r.write("sigstore/trusted_root.json", '{"mediaType":"application/vnd.dev.sigstore.trustedroot+json;version=0.1"}\n');
    writeLockfile(r.dir);
    const head = r.commit("init");
    r.git(["tag", `ci/green/${head}`]);
    await cutRelease({ cwd: r.dir, compiler, label: "v4", actor: "alice", env: {}, now: () => new Date("2026-11-21T11:00:00.000Z") });
  }, 120_000);

  test("signs through the private instance and release verify checks against its trusted root, with cosign faked", async () => {
    const cosign = fakeCosign();
    const forge = startFakeForge("github", API, "acme/api");
    const env = { PATH: process.env.PATH, ...GITHUB_ENV, GITHUB_TOKEN: "ghs_private", CHANT_COSIGN: cosign.path };
    const plan = await preparePublish({ cwd: r.dir, ref: "v4", env, deps: { fetch: forge.fetch } });
    if ("refusal" in plan) throw new Error(plan.refusal.message);
    const ctx = publishContext(plan, { cwd: r.dir, env, log: () => undefined });
    await runPublish({ cwd: r.dir, release: plan.release, label: plan.label, targets: plan.targets, ctx });
    const root = join(r.dir, "sigstore/trusted_root.json");
    const signs = cosign.calls().filter((c) => c.args[0] === "sign-blob" || c.args[0] === "attest-blob");
    expect(signs.length).toBeGreaterThan(0);
    for (const c of signs) expect(c.args).toEqual(expect.arrayContaining(["--use-signing-config=false", "--fulcio-url", FULCIO, "--rekor-url", REKOR, "--trusted-root", root]));

    const download = join(dirname(r.dir), "download-private");
    mkdirSync(download);
    for (const a of forge.releases[0]!.assets) writeFileSync(join(download, a.name), a.bytes);
    const verified = await verifySigstore({ cwd: r.dir, releaseDigest: plan.release.releaseDigest, assetsDir: download, env });
    expect(verified.status).toBe("verified");
    const verifies = cosign.calls().filter((c) => c.args[0]!.startsWith("verify"));
    expect(verifies.length).toBe(verified.checks.length);
    for (const c of verifies) expect(c.args).toEqual(expect.arrayContaining(["--trusted-root", root, "--certificate-oidc-issuer", "https://token.actions.githubusercontent.com"]));
  });
});

describe("Forgejo (#5458)", () => {
  const FORGEJO = {
    GITHUB_ACTIONS: "true",
    FORGEJO_ACTIONS: "true",
    FORGEJO_SERVER_URL: "https://code.example",
    FORGEJO_REPOSITORY: "acme/api",
    FORGEJO_WORKFLOW_REF: "acme/api/.forgejo/workflows/chant-release.yml@refs/tags/release/v5",
  };
  const TOKEN = { ACTIONS_ID_TOKEN_REQUEST_URL: "https://code.example/api/actions/_apis/pipelines/idtoken", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "t" };

  test("a Forgejo job signs keylessly only through a private Fulcio, with the token enable-openid-connect gives it", () => {
    expect(signingIdentity({ ...FORGEJO, ...TOKEN })).toMatchObject({ reason: expect.stringContaining("release.signing.kms or key") });
    expect(signingIdentity(FORGEJO, { fulcio: "https://fulcio.test" })).toMatchObject({ reason: expect.stringContaining("enable-openid-connect: true") });
    expect(signingIdentity({ ...FORGEJO, ...TOKEN }, { fulcio: "https://fulcio.test" })).toEqual({ identity: { issuer: "https://code.example/api/actions", identity: "^https://code\\.example/acme/api/" } });
    expect(signingIdentity({ ...FORGEJO, ...TOKEN }, { fulcio: "https://fulcio.test", issuer: "https://oidc.example" })).toMatchObject({ identity: { issuer: "https://oidc.example" } });
  });

  test("with a private Fulcio and the token, the publish signs keylessly and its statement meets --require-provenance", () => {
    const dir = temp();
    writeFileSync(join(dir, "trusted_root.json"), "{}");
    const setting = resolveSigning({ fulcio: "https://fulcio.test", rekor: "https://rekor.test", trustRoot: "trusted_root.json" }, none);
    const env = { ...FORGEJO, ...TOKEN };
    const prepared = prepareSigning(setting, { env, cwd: dir, redactor: createRedactor(env), signer: fakeSigner() });
    expect(prepared).toMatchObject({ context: { identity: { issuer: "https://code.example/api/actions" }, mode: "keyless" } });
  });

  test("the renderer refuses public keyless signing on Forgejo, and asks for the OIDC token in the jobs that sign through a private Fulcio", () => {
    const job = (text: string, name: string) => text.split(/\n(?=  [a-z][\w-]*:\n)/).find((j) => j.startsWith(`  ${name}:`)) ?? "";
    expect(() => renderReleaseWorkflow({ forge: "forgejo", groups: sc, signing: true, keyless: "public", publish: [{ type: "forge", forge: "forgejo" }] })).toThrow(/release\.signing\.kms.*release\.signing\.key/);
    expect(() => renderReleaseWorkflow({ forge: "forgejo", groups: sc, signing: true, keyless: "public", train: { env: "prod" } })).toThrow(/public Sigstore/);
    // GitHub's public keyless signing is as it was.
    expect(renderReleaseWorkflow({ forge: "github", groups: sc, signing: true, keyless: "public" })).not.toContain("enable-openid-connect");
    const dispatch = renderReleaseWorkflow({ forge: "forgejo", groups: sc, signing: true, keyless: "private", pipeline: { trigger: "dispatch" } });
    expect(job(dispatch, "publish")).toContain("    enable-openid-connect: true");
    expect(job(dispatch, "cut")).toContain("    enable-openid-connect: true");
    expect(job(dispatch, "gate")).not.toContain("enable-openid-connect");
    const noDoctor = renderReleaseWorkflow({ forge: "forgejo", groups: sc, signing: true, keyless: "private", pipeline: { trigger: "dispatch", doctor: false } });
    expect(job(noDoctor, "cut")).not.toContain("enable-openid-connect");
    const train = renderReleaseWorkflow({ forge: "forgejo", groups: sc, signing: true, keyless: "private", train: { env: "prod" }, pipeline: { trigger: "dispatch" } });
    expect(job(train, "publish")).toContain("    enable-openid-connect: true");
    // A key or KMS key needs no token, and renders on Forgejo with its variables in the publish step.
    const kms = renderReleaseWorkflow({ forge: "forgejo", groups: sc, signing: true, signingEnv: ["VAULT_ADDR", "VAULT_TOKEN"], train: { env: "prod" } });
    expect(kms).not.toContain("enable-openid-connect");
    expect(job(kms, "publish")).toContain("VAULT_TOKEN: ${{ secrets.VAULT_TOKEN }}");
  });
});
