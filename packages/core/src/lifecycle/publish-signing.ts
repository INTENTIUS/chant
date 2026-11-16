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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { IN_TOTO_STATEMENT_TYPE } from "./publish-attachments";
import type { Redactor } from "./publish-credentials";
import type { SecurityGroup } from "../workspace/security";
import { PublishTargetError, type PublishContext } from "./release-publish";

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
/** The cosign major version chant runs: 3 writes Sigstore bundles by default. */
export const COSIGN_MAJOR = 3;

/** `release.signing` in `chant.config.ts`. */
export type SigningConfig = boolean | { identity?: string; issuer?: string };

/** Whether a publish signs, and why. */
export interface SigningSetting {
  on: boolean;
  /** `config` (release.signing), `supply-chain` (the group), or `off`. */
  from: "config" | "supply-chain" | "off";
  /** Set when the group asks for signing and `signing: false` turns it off. */
  warning: string | null;
  /** The certificate identity (a regular expression) and issuer a verify expects, when the config names them. */
  identity?: string;
  issuer?: string;
}

/** Whether a publish signs: `release.signing` first, then the `supply-chain` group. */
export function resolveSigning(config: SigningConfig | undefined, groups: ReadonlySet<SecurityGroup>): SigningSetting {
  const named = typeof config === "object" ? { ...(config.identity ? { identity: config.identity } : {}), ...(config.issuer ? { issuer: config.issuer } : {}) } : {};
  if (config === false) {
    return {
      on: false,
      from: "off",
      warning: groups.has("supply-chain") ? "the workspace opts into supply-chain, and release.signing: false publishes images and forge assets without Sigstore signatures or SLSA provenance" : null,
    };
  }
  if (config !== undefined) return { on: true, from: "config", warning: null, ...named };
  return groups.has("supply-chain") ? { on: true, from: "supply-chain", warning: null } : { on: false, from: "off", warning: null };
}

/** Who a keyless signature names: the OIDC issuer and a regular expression the certificate's identity matches. */
export interface SigstoreIdentity {
  issuer: string;
  identity: string;
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether this run can sign keylessly, and the identity its certificate will
 * name: in GitHub Actions, a job with `id-token: write`, whose certificate
 * names a workflow of the repository; in GitLab CI, an ID token named
 * `SIGSTORE_ID_TOKEN` with the audience `sigstore`, whose certificate names
 * the project's pipeline. Anywhere else there is none.
 */
export function signingIdentity(env: NodeJS.ProcessEnv): { identity: SigstoreIdentity } | { reason: string } {
  if (env.GITHUB_ACTIONS === "true") {
    if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) return { reason: "this GitHub Actions job has no OIDC token; give the job permissions: id-token: write" };
    const server = (env.GITHUB_SERVER_URL ?? "https://github.com").replace(/\/+$/, "");
    const repo = env.GITHUB_REPOSITORY;
    if (!repo) return { reason: "this GitHub Actions job has no GITHUB_REPOSITORY" };
    return { identity: { issuer: "https://token.actions.githubusercontent.com", identity: `^${escape(server)}/${escape(repo)}/` } };
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

/**
 * SLSA provenance v1 over `subjects`, from the CI job's environment. In
 * GitHub Actions it is the predicate `actions/attest-build-provenance`
 * writes: the workflow, the event, the repository's ids, the commit and the
 * run. In GitLab CI it names the project, its CI config, the pipeline source
 * and the job. Either adds `internalParameters.chant`, the release's digest,
 * label and member, and the source it resolves is the release's commit.
 */
export function slsaProvenanceStatement(ctx: Pick<PublishContext, "env" | "release" | "label">, subjects: ReadonlyArray<{ name: string; digest: string }>): InTotoStatement {
  const env = ctx.env;
  const chant = { releaseDigest: ctx.release.releaseDigest, label: ctx.label, member: ctx.release.member };
  let predicate: Record<string, unknown>;
  if (env.GITLAB_CI === "true") {
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
  verifyBlob(bundle: Uint8Array, digest: string, id: SigstoreIdentity): Promise<string | null>;
  verifyBlobAttestation(bundle: Uint8Array, digest: string, predicateType: string, id: SigstoreIdentity): Promise<string | null>;
  verifyImage(ref: string, id: SigstoreIdentity): Promise<string | null>;
  verifyImageAttestation(ref: string, predicateType: string, id: SigstoreIdentity): Promise<string | null>;
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
async function cosignRun(cosign: string, args: string[], env: NodeJS.ProcessEnv, redactor: Redactor | null, code: string, what: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await run(cosign, args, { env, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true };
  } catch (err) {
    const e = err as Error & { stderr?: string };
    const tail = String(e.stderr ?? e.message).trim().split("\n").filter(Boolean).slice(-3).join("; ");
    const reason = redactor ? redactor.redact(tail) : tail;
    if (code) throw new PublishTargetError(code, `${what} failed: ${reason}`, "Check that the job's OIDC token reaches cosign and that Fulcio and Rekor are reachable, then run the publish again.");
    return { ok: false, reason };
  }
}

function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "chant-sign-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** A {@link Signer} that runs cosign keylessly, with `env`, which carries the job's OIDC token. */
export function cosignSigner(env: NodeJS.ProcessEnv, redactor: Redactor, cosign = cosignPath(env)): Signer {
  let checked: ReturnType<typeof cosignUnavailable> | null = null;
  const check = () => (checked ??= cosignUnavailable(cosign, env));
  return {
    get name() {
      return `cosign${check().version ? ` ${check().version}` : ""}`;
    },
    unavailable: () => check().reason,
    signBlob: (bytes, name) =>
      withTemp(async (dir) => {
        const file = join(dir, "blob");
        writeFileSync(file, bytes);
        await cosignRun(cosign, ["sign-blob", "--yes", "--new-bundle-format=true", "--bundle", join(dir, "out.json"), file], env, redactor, "publish-signing-failed", `cosign sign-blob for ${name}`);
        return new Uint8Array(readFileSync(join(dir, "out.json")));
      }),
    signStatement: (statement) =>
      withTemp(async (dir) => {
        const file = join(dir, "statement.json");
        writeFileSync(file, JSON.stringify(statement));
        await cosignRun(cosign, ["attest-blob", "--yes", "--new-bundle-format=true", "--statement", file, "--bundle", join(dir, "out.json")], env, redactor, "publish-signing-failed", `cosign attest-blob for ${statement.predicateType}`);
        return new Uint8Array(readFileSync(join(dir, "out.json")));
      }),
  };
}

/** The `--type` cosign takes for a predicate type: its short name for SLSA provenance v1, else the URI. */
const cosignType = (predicateType: string): string => (predicateType === SLSA_PROVENANCE_PREDICATE ? "slsaprovenance1" : predicateType);
const idFlags = (id: SigstoreIdentity): string[] => ["--certificate-identity-regexp", id.identity, "--certificate-oidc-issuer", id.issuer];
const hexOf = (digest: string): string => (digest.includes(":") ? digest.split(":")[1]! : digest);

/** A {@link SigstoreVerifier} that runs cosign. Image checks read the registry with docker's credentials. */
export function cosignVerifier(env: NodeJS.ProcessEnv, cosign = cosignPath(env)): SigstoreVerifier {
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

/** What a target signs with, in the publish context: the signer and the identity its certificate names. */
export interface SigningContext {
  signer: Signer;
  identity: SigstoreIdentity;
}
