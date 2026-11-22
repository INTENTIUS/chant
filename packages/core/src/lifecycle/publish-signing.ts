/**
 * Sigstore signing at publish (#5164): keyless signatures and OIDC-signed
 * SLSA provenance for what the OCI and forge targets publish, beside the
 * release's own provenance statement and the cut's ssh signature, which stay
 * as they are (./publish-attachments.ts).
 *
 * In a CI job with an OIDC token, a target's stage signs before anything is
 * revealed:
 *
 * - an image gets a cosign signature, a Sigstore bundle over an in-toto
 *   statement whose predicate type is `https://sigstore.dev/cosign/sign/v1`,
 *   and SLSA provenance (`https://slsa.dev/provenance/v1`), each pushed as
 *   an OCI referrer of the image with the artifact type
 *   `application/vnd.dev.sigstore.bundle.v0.3+json`, the layout `cosign sign`
 *   and `actions/attest-build-provenance` push. `cosign verify` and `cosign
 *   verify-attestation --type slsaprovenance1` check them.
 * - a forge release gets `<file>.sigstore.json` beside each file it holds (a
 *   `cosign sign-blob` bundle, checked with `cosign verify-blob`) and
 *   {@link SLSA_BUNDLE_FILE}, SLSA provenance over the declared assets.
 *
 * chant writes the statements and runs `cosign` (version 3, the binary
 * `CHANT_COSIGN` names, else `cosign` on `PATH`) to sign them with the job's
 * token: `cosign sign-blob` for a file and `cosign attest-blob --statement`
 * for a statement. It pushes and uploads the bundles itself, with the
 * target's own credentials. The generated release workflow downloads cosign
 * pinned by SHA-256 (../tool-pins.ts).
 *
 * Signing is off unless `release.signing` in `chant.config.ts` turns it on
 * or the workspace opts into the `supply-chain` group, where `signing: false`
 * turns it off with a warning. When it is on and the run can't sign (no OIDC
 * token cosign takes, or no cosign), the publish is refused before anything
 * is sent.
 */

import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { IN_TOTO_STATEMENT_TYPE } from "./publish-attachments";
import type { Redactor } from "./publish-credentials";
import type { SecurityGroup } from "../workspace/security";
import { PublishTargetError, isForgejoJob, type PublishContext } from "./release-publish";
import { keyEnvOf, signingConfigProblems, type SigningConfig } from "./signing-config";

export { isForgejoJob, keyEnvOf, signingConfigProblems, type SigningConfig };

/** The media type of a Sigstore bundle, and the artifact type of a referrer that holds one. */
export const SIGSTORE_BUNDLE_MEDIA_TYPE = "application/vnd.dev.sigstore.bundle.v0.3+json";
/** The predicate type of cosign's image signature statement. */
export const COSIGN_SIGN_PREDICATE = "https://sigstore.dev/cosign/sign/v1";
/** The predicate type of SLSA provenance v1. */
export const SLSA_PROVENANCE_PREDICATE = "https://slsa.dev/provenance/v1";
/** What a file's signature bundle is named after: `<file>.sigstore.json`. */
export const SIGSTORE_BUNDLE_SUFFIX = ".sigstore.json";
/** The forge asset that holds SLSA provenance over the release's assets. */
export const SLSA_BUNDLE_FILE = "release.slsa.sigstore.json";
/** The OCI annotation a bundle referrer names its predicate type under. */
export const BUNDLE_PREDICATE_ANNOTATION = "dev.sigstore.bundle.predicateType";
/** The buildType of SLSA provenance written in GitHub Actions, the one `actions/attest-build-provenance` writes. */
export const GITHUB_BUILD_TYPE = "https://actions.github.io/buildtypes/workflow/v1";
/** The buildType of SLSA provenance written in GitLab CI. */
export const GITLAB_BUILD_TYPE = "https://intentius.io/chant/release/build/gitlab-ci/v1";
/** The buildType of SLSA provenance written in Forgejo Actions (#5458). */
export const FORGEJO_BUILD_TYPE = "https://intentius.io/chant/release/build/forgejo-actions/v1";
/** The buildType of SLSA provenance written outside a forge's CI: a `chant ci serve` host or a workstation (#5458). */
export const HOST_BUILD_TYPE = "https://intentius.io/chant/release/build/host/v1";
/** The builder id of a `chant ci serve` host, followed by its runner key's fingerprint (#5458). */
export const CI_SERVE_BUILDER = "https://intentius.io/chant/release/builder/ci-serve/";
/** The builder id of a publish run by hand, outside any CI (#5458). */
export const WORKSTATION_BUILDER = "https://intentius.io/chant/release/builder/workstation";
/**
 * The variable a `chant ci serve` host sets for the publish it runs: its
 * runner key's ssh fingerprint (`SHA256:...`), which the SLSA statement
 * names as the builder (#5458).
 */
export const RUNNER_FINGERPRINT_ENV = "CHANT_RELEASE_RUNNER_KEY_FINGERPRINT";
/** The cosign major version chant runs: 3 writes Sigstore bundles by default. */
export const COSIGN_MAJOR = 3;

/** How a publish signs: keylessly with an OIDC token, or with a key (#5458). */
export type SigningMode = "keyless" | "key";

/** The variable cosign reads a key's password from. */
export const COSIGN_PASSWORD_ENV = "COSIGN_PASSWORD";

/** Whether a publish signs, and why. */
export interface SigningSetting {
  on: boolean;
  /** `config` (release.signing), `supply-chain` (the group), or `off`. */
  from: "config" | "supply-chain" | "off";
  /** Set when the group asks for signing and `signing: false` turns it off. */
  warning: string | null;
  /** How it signs (#5458): `keyless` unless the config names a key. */
  mode: SigningMode;
  /** The certificate identity (a regular expression) and issuer a verify expects, when the config names them. */
  identity?: string;
  issuer?: string;
  /** `key` mode: the key, a file from the member or `env://NAME`, and the variable holding its password. */
  key?: string;
  passwordEnv?: string;
  /** `key` mode: the PEM public key a verify checks against, from the member. */
  publicKey?: string;
  /** False when the signature goes to no transparency log (`rekor: false`). */
  tlog: boolean;
}

/** Whether a publish signs: `release.signing` first, then the `supply-chain` group. */
export function resolveSigning(config: SigningConfig | undefined, groups: ReadonlySet<SecurityGroup>): SigningSetting {
  if (config === false) {
    return {
      on: false,
      from: "off",
      mode: "keyless",
      tlog: true,
      warning: groups.has("supply-chain") ? "the workspace opts into supply-chain, and release.signing: false publishes images and forge assets without Sigstore signatures or SLSA provenance" : null,
    };
  }
  if (config !== undefined) {
    const c = typeof config === "object" ? config : {};
    const mode: SigningMode = c.key ? "key" : "keyless";
    return {
      on: true,
      from: "config",
      warning: null,
      mode,
      tlog: c.rekor !== false,
      ...(c.identity ? { identity: c.identity } : {}),
      ...(c.issuer ? { issuer: c.issuer } : {}),
      ...(c.key ? { key: c.key, passwordEnv: c.passwordEnv ?? COSIGN_PASSWORD_ENV } : {}),
      ...(c.publicKey ? { publicKey: c.publicKey } : {}),
    };
  }
  return groups.has("supply-chain") ? { on: true, from: "supply-chain", warning: null, mode: "keyless", tlog: true } : { on: false, from: "off", warning: null, mode: "keyless", tlog: true };
}

/** Who a keyless signature names: the OIDC issuer and a regular expression the certificate's identity matches. */
export interface SigstoreIdentity {
  issuer: string;
  identity: string;
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const trimSlash = (s: string): string => s.replace(/\/+$/, "");

/** Where a release is built: a forge's CI, a `chant ci serve` host, or a workstation (#5458). */
export type ReleaseBuildKind = "github" | "gitlab" | "forgejo" | "host" | "workstation";

/** Where this run builds the release, from its environment (#5458). */
export function releaseBuildKind(env: NodeJS.ProcessEnv): ReleaseBuildKind {
  if (isForgejoJob(env)) return "forgejo";
  if (env.GITHUB_ACTIONS === "true") return "github";
  if (env.GITLAB_CI === "true") return "gitlab";
  if (env[RUNNER_FINGERPRINT_ENV]) return "host";
  return "workstation";
}

/**
 * The OIDC issuer of a GitHub Actions token on `server`: GitHub's own on
 * github.com, `token.actions.<host>` on a GHE.com host, and the server's
 * `/_services/token` on GitHub Enterprise Server.
 */
export function githubOidcIssuer(server: string): string {
  const url = trimSlash(server);
  const host = url.replace(/^https?:\/\//, "");
  if (host === "github.com") return "https://token.actions.githubusercontent.com";
  if (host.endsWith(".ghe.com")) return `https://token.actions.${host}`;
  return `${url}/_services/token`;
}

/** The server and repository of a Forgejo job, from its `FORGEJO_*` variables, else the `GITHUB_*` ones an older runner sets. */
function forgejoJob(env: NodeJS.ProcessEnv) {
  return {
    server: trimSlash(env.FORGEJO_SERVER_URL ?? env.GITHUB_SERVER_URL ?? ""),
    repo: env.FORGEJO_REPOSITORY ?? env.GITHUB_REPOSITORY ?? "",
    workflowRef: env.FORGEJO_WORKFLOW_REF ?? env.GITHUB_WORKFLOW_REF ?? "",
    ref: env.FORGEJO_REF ?? env.GITHUB_REF ?? "",
    runNumber: env.FORGEJO_RUN_NUMBER ?? env.GITHUB_RUN_NUMBER ?? "",
    runId: env.FORGEJO_RUN_ID ?? env.GITHUB_RUN_ID ?? "",
    event: env.FORGEJO_EVENT_NAME ?? env.GITHUB_EVENT_NAME ?? null,
  };
}

/**
 * Whether this run can sign keylessly, and the identity its certificate will
 * name: in GitHub Actions, a job with `id-token: write`, whose certificate
 * names a workflow of the repository and is issued by the server's token
 * service; in GitLab CI, an ID token named `SIGSTORE_ID_TOKEN` with the
 * audience `sigstore`, whose certificate names the project's pipeline.
 * A Forgejo job is never taken for GitHub (#5458). Anywhere else there is none.
 */
export function signingIdentity(env: NodeJS.ProcessEnv): { identity: SigstoreIdentity } | { reason: string } {
  if (isForgejoJob(env)) {
    return { reason: "this is a Forgejo Actions job, and public Sigstore issues no certificate for a Forgejo token; sign with release.signing.kms or key" };
  }
  if (env.GITHUB_ACTIONS === "true") {
    if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) return { reason: "this GitHub Actions job has no OIDC token; give the job permissions: id-token: write" };
    const server = trimSlash(env.GITHUB_SERVER_URL ?? "https://github.com");
    const repo = env.GITHUB_REPOSITORY;
    if (!repo) return { reason: "this GitHub Actions job has no GITHUB_REPOSITORY" };
    return { identity: { issuer: githubOidcIssuer(server), identity: `^${escape(server)}/${escape(repo)}/` } };
  }
  if (env.GITLAB_CI === "true") {
    if (!env.SIGSTORE_ID_TOKEN) return { reason: "this GitLab CI job has no SIGSTORE_ID_TOKEN; declare it under the job's id_tokens with aud: sigstore" };
    const server = (env.CI_SERVER_URL ?? "https://gitlab.com").replace(/\/+$/, "");
    const project = env.CI_PROJECT_PATH;
    if (!project) return { reason: "this GitLab CI job has no CI_PROJECT_PATH" };
    return { identity: { issuer: server, identity: `^${escape(server)}/${escape(project)}//` } };
  }
  return { reason: "this run is not in GitHub Actions or GitLab CI, and keyless signing needs a CI job's OIDC token" };
}

/** An in-toto Statement v1. */
export interface InTotoStatement {
  _type: string;
  subject: Array<{ name: string; digest: Record<string, string> }>;
  predicateType: string;
  predicate: Record<string, unknown>;
}

const subjectOf = (s: { name: string; digest: string }) => {
  const [alg, hex] = s.digest.includes(":") ? s.digest.split(":") : ["sha256", s.digest];
  return { name: s.name, digest: { [alg!]: hex! } };
};

/** The statement cosign signs for an image: its digest under `https://sigstore.dev/cosign/sign/v1`, with an empty predicate. */
export function cosignSignStatement(subject: { name: string; digest: string }): InTotoStatement {
  return { _type: IN_TOTO_STATEMENT_TYPE, subject: [subjectOf(subject)], predicateType: COSIGN_SIGN_PREDICATE, predicate: {} };
}

/** The `origin` remote of `cwd` without any credentials in it, or null. */
function originUrl(cwd: string | undefined): string | null {
  if (!cwd) return null;
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return url ? url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, "$1") : null;
  } catch {
    return null;
  }
}

/**
 * SLSA provenance v1 over `subjects`, naming the environment that built the
 * release (#5458), each with its own build type and builder id:
 *
 * - GitHub Actions: the predicate `actions/attest-build-provenance` writes,
 *   the workflow, the event, the repository's ids, the commit and the run.
 * - GitLab CI: the project, its CI config, the pipeline source and the job.
 * - Forgejo Actions: the server, the repository, the workflow and the run.
 * - a `chant ci serve` host: its runner key's fingerprint
 *   ({@link RUNNER_FINGERPRINT_ENV}) as the builder.
 * - a workstation: {@link WORKSTATION_BUILDER}, with no builder identity.
 *
 * Each adds `internalParameters.chant`, the release's digest, label and
 * member, and the source it resolves is the release's commit.
 */
export function slsaProvenanceStatement(ctx: Pick<PublishContext, "env" | "release" | "label"> & { cwd?: string }, subjects: ReadonlyArray<{ name: string; digest: string }>): InTotoStatement {
  const env = ctx.env;
  const chant = { releaseDigest: ctx.release.releaseDigest, label: ctx.label, member: ctx.release.member };
  const kind = releaseBuildKind(env);
  let predicate: Record<string, unknown>;
  if (kind === "forgejo") {
    const f = forgejoJob(env);
    const path = f.workflowRef.startsWith(`${f.repo}/`) ? f.workflowRef.slice(f.repo.length + 1).split("@")[0]! : f.workflowRef.split("@")[0]!;
    predicate = {
      buildDefinition: {
        buildType: FORGEJO_BUILD_TYPE,
        externalParameters: { workflow: { ref: f.ref, repository: `${f.server}/${f.repo}`, path } },
        internalParameters: { forgejo: { event_name: f.event, run_id: f.runId || null }, chant },
        resolvedDependencies: [{ uri: `git+${f.server}/${f.repo}@${f.ref}`, digest: { gitCommit: ctx.release.commit } }],
      },
      runDetails: {
        builder: { id: `${f.server}/${f.workflowRef}` },
        metadata: { invocationId: `${f.server}/${f.repo}/actions/runs/${f.runNumber}` },
      },
    };
  } else if (kind === "host" || kind === "workstation") {
    const origin = originUrl(ctx.cwd);
    const fingerprint = env[RUNNER_FINGERPRINT_ENV] ?? null;
    predicate = {
      buildDefinition: {
        buildType: HOST_BUILD_TYPE,
        externalParameters: { source: origin, commit: ctx.release.commit },
        internalParameters: { host: { runner: kind === "host" ? "ci-serve" : "workstation", runnerKey: fingerprint }, chant },
        resolvedDependencies: [{ ...(origin ? { uri: `git+${origin}` } : {}), digest: { gitCommit: ctx.release.commit } }],
      },
      runDetails: {
        builder: { id: kind === "host" ? `${CI_SERVE_BUILDER}${encodeURIComponent(fingerprint!)}` : WORKSTATION_BUILDER },
        metadata: {},
      },
    };
  } else if (kind === "gitlab") {
    const server = (env.CI_SERVER_URL ?? "https://gitlab.com").replace(/\/+$/, "");
    const project = `${server}/${env.CI_PROJECT_PATH ?? ""}`;
    const ref = env.CI_COMMIT_TAG ? `refs/tags/${env.CI_COMMIT_TAG}` : `refs/heads/${env.CI_COMMIT_REF_NAME ?? ""}`;
    predicate = {
      buildDefinition: {
        buildType: GITLAB_BUILD_TYPE,
        externalParameters: { project, ref, configPath: env.CI_CONFIG_PATH ?? ".gitlab-ci.yml" },
        internalParameters: { gitlab: { pipelineSource: env.CI_PIPELINE_SOURCE ?? null, projectId: env.CI_PROJECT_ID ?? null, runnerEnvironment: env.CI_RUNNER_EXECUTABLE_ARCH ?? null }, chant },
        resolvedDependencies: [{ uri: `git+${project}@${ref}`, digest: { gitCommit: ctx.release.commit } }],
      },
      runDetails: {
        builder: { id: `${project}//${env.CI_CONFIG_PATH ?? ".gitlab-ci.yml"}@${ref}` },
        metadata: { invocationId: env.CI_JOB_URL ?? `${project}/-/jobs/${env.CI_JOB_ID ?? ""}` },
      },
    };
  } else {
    const server = (env.GITHUB_SERVER_URL ?? "https://github.com").replace(/\/+$/, "");
    const repo = env.GITHUB_REPOSITORY ?? "";
    const workflowRef = env.GITHUB_WORKFLOW_REF ?? "";
    const path = workflowRef.startsWith(`${repo}/`) ? workflowRef.slice(repo.length + 1).split("@")[0]! : workflowRef.split("@")[0]!;
    const ref = env.GITHUB_REF ?? "";
    predicate = {
      buildDefinition: {
        buildType: GITHUB_BUILD_TYPE,
        externalParameters: { workflow: { ref, repository: `${server}/${repo}`, path } },
        internalParameters: {
          github: { event_name: env.GITHUB_EVENT_NAME ?? null, repository_id: env.GITHUB_REPOSITORY_ID ?? null, repository_owner_id: env.GITHUB_REPOSITORY_OWNER_ID ?? null, runner_environment: env.RUNNER_ENVIRONMENT ?? null },
          chant,
        },
        resolvedDependencies: [{ uri: `git+${server}/${repo}@${ref}`, digest: { gitCommit: ctx.release.commit } }],
      },
      runDetails: {
        builder: { id: `${server}/${workflowRef}` },
        metadata: { invocationId: `${server}/${repo}/actions/runs/${env.GITHUB_RUN_ID ?? ""}/attempts/${env.GITHUB_RUN_ATTEMPT ?? "1"}` },
      },
    };
  }
  return { _type: IN_TOTO_STATEMENT_TYPE, subject: subjects.map(subjectOf), predicateType: SLSA_PROVENANCE_PREDICATE, predicate };
}

/** What a key-signed bundle names in place of a certificate (#5458): the public key from the member that verifies it. */
export interface KeyIdentity {
  key: string;
}

/** What a bundle is verified against: a keyless certificate's issuer and identity, or a key. */
export type SigningIdentity = SigstoreIdentity | KeyIdentity;

/** Whether `id` names a key rather than a certificate. */
export function isKeyIdentity(id: SigningIdentity): id is KeyIdentity {
  return "key" in id && typeof (id as KeyIdentity).key === "string";
}

/** In a sentence, who signed: the certificate's identity and issuer, or the key. */
export function describeSigningIdentity(id: SigningIdentity): string {
  return isKeyIdentity(id) ? `the key ${id.key}` : `${id.identity}, issuer ${id.issuer}`;
}

/** Signs with Sigstore. Injected, so tests sign with a fake. */
export interface Signer {
  /** What signs, for messages, such as `cosign v3.1.4`. */
  readonly name: string;
  /** Null when it can sign here, else why not, in a sentence. */
  unavailable(): string | null;
  /** A bundle with a signature over `bytes` (`cosign sign-blob`). */
  signBlob(bytes: Uint8Array, name: string): Promise<Uint8Array>;
  /** A bundle with `statement` signed as a DSSE envelope (`cosign attest-blob --statement`). */
  signStatement(statement: InTotoStatement): Promise<Uint8Array>;
}

/** Checks Sigstore signatures. Injected, so tests check with a fake. Each check gives null when it verifies, else why not. */
export interface SigstoreVerifier {
  readonly name: string;
  unavailable(): string | null;
  verifyBlob(bundle: Uint8Array, digest: string, id: SigningIdentity): Promise<string | null>;
  verifyBlobAttestation(bundle: Uint8Array, digest: string, predicateType: string, id: SigningIdentity): Promise<string | null>;
  verifyImage(ref: string, id: SigningIdentity): Promise<string | null>;
  verifyImageAttestation(ref: string, predicateType: string, id: SigningIdentity): Promise<string | null>;
}

/** The cosign a run uses: `CHANT_COSIGN`, else `cosign` on `PATH`. */
export function cosignPath(env: NodeJS.ProcessEnv): string {
  return env.CHANT_COSIGN && env.CHANT_COSIGN !== "" ? env.CHANT_COSIGN : "cosign";
}

/** Null when `cosign` runs and is version {@link COSIGN_MAJOR} or later, else why not. */
function cosignUnavailable(cosign: string, env: NodeJS.ProcessEnv): { version: string | null; reason: string | null } {
  let out: string;
  try {
    out = execFileSync(cosign, ["version"], { encoding: "utf-8", env, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string };
    if (e.code === "ENOENT") return { version: null, reason: `${cosign} is not there: install cosign ${COSIGN_MAJOR} on PATH, or set CHANT_COSIGN to it` };
    out = String(e.stdout ?? "");
    if (!out) return { version: null, reason: `${cosign} version failed: ${e.message}` };
  }
  const v = /GitVersion:\s*v?(\d+)\.(\d+)\.(\d+)/.exec(out);
  if (!v) return { version: null, reason: `${cosign} version printed no GitVersion, so chant can't tell it is cosign ${COSIGN_MAJOR}` };
  const version = `v${v[1]}.${v[2]}.${v[3]}`;
  return Number(v[1]) < COSIGN_MAJOR ? { version, reason: `${cosign} is cosign ${version}, and chant signs with cosign ${COSIGN_MAJOR} or later` } : { version, reason: null };
}

const run = promisify(execFile);

/** Run cosign with `args`; a failure is a {@link PublishTargetError} with `code` and the end of its stderr, redacted. */
async function cosignRun(cosign: string, args: string[], env: NodeJS.ProcessEnv, redactor: Redactor | null, code: string, what: string, fix = "Check that the job's OIDC token reaches cosign and that Fulcio and Rekor are reachable, then run the publish again."): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await run(cosign, args, { env, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true };
  } catch (err) {
    const e = err as Error & { stderr?: string };
    const tail = String(e.stderr ?? e.message).trim().split("\n").filter(Boolean).slice(-3).join("; ");
    const reason = redactor ? redactor.redact(tail) : tail;
    if (code) throw new PublishTargetError(code, `${what} failed: ${reason}`, fix);
    return { ok: false, reason };
  }
}

function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "chant-sign-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/**
 * How cosign signs (#5458): keylessly with the job's token, or with `key`, a
 * key file's absolute path or `env://NAME`, whose password cosign reads from
 * `passwordEnv`. `tlog: false` writes no transparency log entry.
 */
export interface CosignSignOptions {
  mode: SigningMode;
  key?: string;
  passwordEnv?: string;
  tlog?: boolean;
}

/** The flags `cosign sign-blob` and `attest-blob` get for `o`, before their own. */
export function cosignSigningFlags(o: CosignSignOptions): string[] {
  const flags: string[] = [];
  if (o.mode !== "keyless" && o.key) flags.push("--key", o.key);
  if (o.tlog === false) flags.push("--use-signing-config=false", "--tlog-upload=false");
  return flags;
}

/** The environment cosign signs with: the run's, and in `key` mode the key's password as `COSIGN_PASSWORD`. */
export function cosignSigningEnv(env: NodeJS.ProcessEnv, o: CosignSignOptions): NodeJS.ProcessEnv {
  if (o.mode !== "key") return env;
  return { ...env, [COSIGN_PASSWORD_ENV]: env[o.passwordEnv ?? COSIGN_PASSWORD_ENV] ?? "" };
}

/** A {@link Signer} that runs cosign with `env`, keylessly with the job's OIDC token unless `o` names a key. */
export function cosignSigner(env: NodeJS.ProcessEnv, redactor: Redactor, cosign = cosignPath(env), o: CosignSignOptions = { mode: "keyless" }): Signer {
  let checked: ReturnType<typeof cosignUnavailable> | null = null;
  const check = () => (checked ??= cosignUnavailable(cosign, env));
  const flags = cosignSigningFlags(o);
  const signEnv = cosignSigningEnv(env, o);
  const fix = o.mode === "keyless" ? undefined : "Check that the key and its credentials reach cosign in the publish step, then run the publish again.";
  return {
    get name() {
      return `cosign${check().version ? ` ${check().version}` : ""}`;
    },
    unavailable: () => check().reason,
    signBlob: (bytes, name) =>
      withTemp(async (dir) => {
        const file = join(dir, "blob");
        writeFileSync(file, bytes);
        await cosignRun(cosign, ["sign-blob", "--yes", "--new-bundle-format=true", ...flags, "--bundle", join(dir, "out.json"), file], signEnv, redactor, "publish-signing-failed", `cosign sign-blob for ${name}`, fix);
        return new Uint8Array(readFileSync(join(dir, "out.json")));
      }),
    signStatement: (statement) =>
      withTemp(async (dir) => {
        const file = join(dir, "statement.json");
        writeFileSync(file, JSON.stringify(statement));
        await cosignRun(cosign, ["attest-blob", "--yes", "--new-bundle-format=true", ...flags, "--statement", file, "--bundle", join(dir, "out.json")], signEnv, redactor, "publish-signing-failed", `cosign attest-blob for ${statement.predicateType}`, fix);
        return new Uint8Array(readFileSync(join(dir, "out.json")));
      }),
  };
}

/** The `--type` cosign takes for a predicate type: its short name for SLSA provenance v1, else the URI. */
const cosignType = (predicateType: string): string => (predicateType === SLSA_PROVENANCE_PREDICATE ? "slsaprovenance1" : predicateType);
const hexOf = (digest: string): string => (digest.includes(":") ? digest.split(":")[1]! : digest);

/** How cosign verifies (#5458): `tlog: false` for a signature that went to no transparency log. */
export interface CosignVerifyOptions {
  tlog?: boolean;
}

/** The flags a cosign verify gets for `id`: the certificate's identity and issuer, or `--key`. */
export function cosignVerifyFlags(id: SigningIdentity, o: CosignVerifyOptions = {}): string[] {
  const who = isKeyIdentity(id) ? ["--key", id.key] : ["--certificate-identity-regexp", id.identity, "--certificate-oidc-issuer", id.issuer];
  return [...who, ...(o.tlog === false ? ["--insecure-ignore-tlog=true"] : [])];
}

/** A {@link SigstoreVerifier} that runs cosign. Image checks read the registry with docker's credentials. */
export function cosignVerifier(env: NodeJS.ProcessEnv, cosign = cosignPath(env), o: CosignVerifyOptions = {}): SigstoreVerifier {
  let checked: ReturnType<typeof cosignUnavailable> | null = null;
  const check = () => (checked ??= cosignUnavailable(cosign, env));
  const go = async (args: string[]): Promise<string | null> => {
    const r = await cosignRun(cosign, args, env, null, "", "");
    return r.ok ? null : r.reason;
  };
  const blob = (bundle: Uint8Array, args: (file: string) => string[]) =>
    withTemp(async (dir) => {
      const file = join(dir, "bundle.json");
      writeFileSync(file, bundle);
      return go(args(file));
    });
  const idFlags = (id: SigningIdentity) => cosignVerifyFlags(id, o);
  return {
    get name() {
      return `cosign${check().version ? ` ${check().version}` : ""}`;
    },
    unavailable: () => check().reason,
    verifyBlob: (bundle, digest, id) => blob(bundle, (f) => ["verify-blob", "--bundle", f, ...idFlags(id), `sha256:${hexOf(digest)}`]),
    verifyBlobAttestation: (bundle, digest, predicateType, id) => blob(bundle, (f) => ["verify-blob-attestation", "--bundle", f, "--type", cosignType(predicateType), "--digest", hexOf(digest), "--digestAlg", "sha256", ...idFlags(id)]),
    verifyImage: (ref, id) => go(["verify", ...idFlags(id), ref]),
    verifyImageAttestation: (ref, predicateType, id) => go(["verify-attestation", "--type", cosignType(predicateType), ...idFlags(id), ref]),
  };
}

/** What a target signs with, in the publish context: the signer and who its bundles name. */
export interface SigningContext {
  signer: Signer;
  identity: SigningIdentity;
  /** How it signs (#5458). Absent: keyless. */
  mode?: SigningMode;
}

/** Why a publish that should sign can't, before anything is sent. */
export interface SigningRefusal {
  code: "publish-signing-no-oidc" | "publish-signing-tool-missing" | "publish-signing-key-missing";
  /** What is missing, in a clause. */
  reason: string;
  fix: string;
}

/**
 * The variables the signing step needs from the CI's secrets in the mode
 * `setting` names (#5458): a key held in a variable and its password. The
 * release workflow passes them to the publish step alone.
 */
export function signingStepVariables(setting: SigningSetting): string[] {
  if (!setting.on || setting.mode !== "key") return [];
  const variable = keyEnvOf(setting.key!);
  return [...(variable ? [variable] : []), setting.passwordEnv ?? COSIGN_PASSWORD_ENV];
}

/** The fix for a keyless run with no OIDC token. */
export const KEYLESS_FIX = "Publish from a CI job with an OIDC token (GitHub Actions: permissions: id-token: write; GitLab CI: SIGSTORE_ID_TOKEN under id_tokens with aud: sigstore), sign with a key (release.signing.key), or set release.signing: false.";

/**
 * Whether the mode `setting` names can sign in this run, without running
 * cosign (#5458): a keyless run needs an OIDC token cosign takes; `key`
 * needs its file or variable, its password variable, and its public key.
 * Null when it can, else the refusal.
 */
export function signingReadiness(setting: SigningSetting, env: NodeJS.ProcessEnv, cwd: string): SigningRefusal | null {
  if (setting.mode === "key") {
    const key = setting.key!;
    const variable = keyEnvOf(key);
    if (variable !== null && !env[variable]) return { code: "publish-signing-key-missing", reason: `release.signing.key reads the key from ${variable}, which is not set here`, fix: `Give the publish step ${variable}, the cosign private key in PEM, as chant release workflow does from the repository's secrets.` };
    if (variable === null && !existsSync(resolve(cwd, key))) return { code: "publish-signing-key-missing", reason: `release.signing.key names ${key}, which is not there`, fix: "Put the cosign key file where release.signing.key names it, or use env://NAME for a key held in a variable." };
    const password = setting.passwordEnv ?? COSIGN_PASSWORD_ENV;
    if (env[password] === undefined) return { code: "publish-signing-key-missing", reason: `the key's password is read from ${password}, which is not set here`, fix: `Give the publish step ${password}, empty for a key made with no password.` };
    if (setting.publicKey && !existsSync(resolve(cwd, setting.publicKey))) return { code: "publish-signing-key-missing", reason: `release.signing.publicKey names ${setting.publicKey}, which is not there, so nothing could verify what the key signs`, fix: "Commit the key's public half where release.signing.publicKey names it (cosign public-key --key <key>)." };
    return null;
  }
  const id = signingIdentity(env);
  return "reason" in id ? { code: "publish-signing-no-oidc", reason: `this run can't sign keylessly: ${id.reason}`, fix: KEYLESS_FIX } : null;
}

/**
 * What a publish signs with (#5458), or why it can't: the mode's readiness
 * ({@link signingReadiness}), then cosign. `signer` replaces cosign, as a
 * test's fake does.
 */
export function prepareSigning(setting: SigningSetting, req: { env: NodeJS.ProcessEnv; cwd: string; redactor: Redactor; signer?: Signer }): { context: SigningContext } | { refusal: SigningRefusal } {
  const refused = signingReadiness(setting, req.env, req.cwd);
  if (refused) return { refusal: refused };
  const options: CosignSignOptions =
    setting.mode === "key"
      ? { mode: "key", key: keyEnvOf(setting.key!) !== null ? setting.key! : resolve(req.cwd, setting.key!), passwordEnv: setting.passwordEnv ?? COSIGN_PASSWORD_ENV, tlog: setting.tlog }
      : { mode: "keyless" };
  const signer = req.signer ?? cosignSigner(req.env, req.redactor, cosignPath(req.env), options);
  const missing = signer.unavailable();
  if (missing) return { refusal: { code: "publish-signing-tool-missing", reason: missing, fix: "Install cosign 3 in the job, as chant release workflow does, or point CHANT_COSIGN at it." } };
  if (setting.mode === "key") return { context: { signer, identity: { key: setting.publicKey! }, mode: "key" } };
  const id = signingIdentity(req.env) as { identity: SigstoreIdentity };
  return { context: { signer, identity: id.identity, mode: "keyless" } };
}
