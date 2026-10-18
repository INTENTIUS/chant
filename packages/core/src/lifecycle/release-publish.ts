/**
 * Publishing a cut release (#4027): the contract `chant release publish`
 * keeps, and the hook its targets fill in.
 *
 * A publish takes a release by label or digest and, before it publishes
 * anything, refuses:
 *
 * - a release no cut names (`release-not-found`);
 * - a release cut from a revoked commit (`release-revoked`, #4033);
 * - under an `identity.gates` entry for `release` (#4031), a release none of
 *   whose cuts carries a signature that verifies for its actor, in the gate's
 *   class when it names one (`release-unsigned` or `release-signature-unverified`).
 *
 * It then says whether the run has an OIDC token to sign provenance with
 * ({@link detectProvenance}), and warns when it has none, before any target
 * runs. The targets come from {@link releasePublishTargets}: the member
 * declares them under `release.publish` in its `chant.config.ts` (#4047).
 * With a target, the checkout must be the release's commit with a clean
 * tree ({@link checkCheckoutIsRelease}), every target is planned before any
 * publishes, and without `--yes` nothing is published. All-or-nothing and
 * resume are #4048, and signing, SBOMs and provenance are #4049. The publish steps a component
 * declares (`publish-image`, `publish-artifact`, `publish-asset`,
 * `load-image-on-host`) are deploy steps: they run in each environment's
 * deploy of the release (`chant components promote --release`), never here.
 */

import { execFileSync } from "node:child_process";
import type { Release } from "./release-store";
import { createRedactor, type Redactor } from "./publish-credentials";

/** Whether this run can sign provenance with an OIDC token, and why not when it can't. */
export interface ProvenanceCheck {
  /** True when the run has an OIDC token a registry accepts for provenance. */
  oidc: boolean;
  /** The CI the run is in, or null on a workstation. */
  ci: "github" | "gitlab" | null;
  /** One sentence on what was found. */
  reason: string;
}

/**
 * Whether the process environment gives this run an OIDC token for
 * provenance: in GitHub Actions, `ACTIONS_ID_TOKEN_REQUEST_URL` and
 * `ACTIONS_ID_TOKEN_REQUEST_TOKEN`, which a job with `id-token: write` gets;
 * in GitLab CI, an ID token named `SIGSTORE_ID_TOKEN` or `NPM_ID_TOKEN`
 * declared under the job's `id_tokens`. Anywhere else there is none.
 */
export function detectProvenance(env: NodeJS.ProcessEnv = process.env): ProvenanceCheck {
  if (env.GITHUB_ACTIONS === "true") {
    return env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
      ? { oidc: true, ci: "github", reason: "GitHub Actions hands this job an OIDC token" }
      : { oidc: false, ci: "github", reason: "this GitHub Actions job has no OIDC token; give the job permissions: id-token: write" };
  }
  if (env.GITLAB_CI === "true") {
    return env.SIGSTORE_ID_TOKEN || env.NPM_ID_TOKEN
      ? { oidc: true, ci: "gitlab", reason: "GitLab CI hands this job an ID token" }
      : { oidc: false, ci: "gitlab", reason: "this GitLab CI job has no ID token; declare SIGSTORE_ID_TOKEN under the job's id_tokens" };
  }
  return { oidc: false, ci: null, reason: "this run is not in CI, and a workstation has no OIDC token" };
}

/** One thing a target publishes: a package, an image, an asset. */
export interface PublishItem {
  /** What it is, such as `@acme/core@1.4.0` or `api-linux-amd64.tar.gz`. */
  name: string;
  /** Where it goes, such as `ghcr.io/acme/api@sha256:...` or a release's asset URL. */
  destination: string;
  /** Its digest, when the target knows one. */
  digest?: string;
  /** True when the destination already held it, so nothing was uploaded. */
  present?: boolean;
}

/** What one target published. */
export interface PublishedTarget {
  target: string;
  /** Where it went, such as a registry and a package name. */
  destination: string;
  /** Each thing published, in order. */
  items: PublishItem[];
}

/** Injected into the targets, so tests drive them with fakes. */
export interface PublishDeps {
  /** The HTTP client the OCI and forge targets use. Default: the global `fetch`. */
  fetch?: PublishFetch;
  /** The npm executable. Default: `npm` on `PATH`. */
  npm?: string;
}

/** The subset of the WHATWG `fetch` the targets use. */
export type PublishFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: Uint8Array | string; redirect?: "follow" | "manual" },
) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

/** What a target is given to plan and to publish. */
export interface PublishContext {
  release: Release;
  label: string | null;
  /** The tag the cut made for the release, `release/<label>` or `release/<member>/<label>`, or null for a release with no label. */
  releaseTag: string | null;
  provenance: ProvenanceCheck;
  /** The member's directory, which the declaration's paths are relative to. */
  cwd: string;
  /**
   * A tag to publish under in place of the target's own: npm's dist-tag
   * (default `latest`) and the OCI tags. Null for the target's own. #4048
   * stages a set of packages under one, then moves it.
   */
  tag: string | null;
  /** The environment credentials are read from. */
  env: NodeJS.ProcessEnv;
  /** Masks credentials; every line a target logs and every error it throws goes through it. */
  redactor: Redactor;
  /** Print one line of progress. The line is redacted. */
  log(line: string): void;
}

/** A target refused or failed. The message never holds a credential. */
export class PublishTargetError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly fix?: string,
  ) {
    super(message);
    this.name = "PublishTargetError";
  }
}

/**
 * One place a release is published to (#4047). A target publishes the
 * release's artifacts as they were built at the cut, checked against their
 * digests where the release records them, and never builds. Targets are
 * declared under `release.publish` in the member's `chant.config.ts`
 * (./publish-declaration.ts) and made by `createPublishTargets`
 * (./publish-targets.ts). A new kind of target is a new member of the
 * declaration's union and a factory that returns this interface.
 */
export interface PublishTarget {
  /** The declaration's `type`. */
  kind: "npm" | "oci" | "forge";
  /** A name for messages, such as `npm (2 packages)`. */
  name: string;
  /** Where it publishes, for the line printed before it runs. */
  destination: string;
  /** The environment variables it reads credentials from, whose values are masked in all output. */
  credentialEnv: string[];
  /**
   * Read what it would publish and check that it can: the files are there,
   * they match the release's digests, the credentials it needs are set.
   * Uploads nothing and makes no request that changes anything. Throws
   * {@link PublishTargetError}. The dry run prints what it returns, and a
   * publish plans every target before any of them publishes.
   */
  plan(ctx: PublishContext): Promise<PublishItem[]>;
  /** Publish. Throws {@link PublishTargetError} naming what was already published when it fails part way. */
  publish(ctx: PublishContext): Promise<PublishedTarget>;
}

/** The targets the member at `cwd` declares under `release.publish` in its `chant.config.ts`. */
export async function releasePublishTargets(cwd: string, deps: PublishDeps = {}): Promise<PublishTarget[]> {
  const { loadChantConfig } = await import("../config");
  const { createPublishTargets } = await import("./publish-targets");
  const { config } = await loadChantConfig(cwd);
  return createPublishTargets(config.release?.publish ?? [], deps);
}

/** Why a publish was refused before anything ran. */
export interface PublishRefusal {
  code:
    | "release-not-found"
    | "release-revoked"
    | "release-unsigned"
    | "release-signature-unverified"
    | "publish-config-invalid"
    | "release-head-mismatch"
    | "release-worktree-dirty";
  message: string;
  fix?: string;
}

/** A release ready to publish: what it is, how its signature reads, the provenance check, and its targets. */
export interface PublishPlan {
  release: Release;
  label: string | null;
  /** The verified cut's signature when one verifies, else the newest cut's. */
  signature: { status: "verified" | "unsigned" | "unverified"; actor: string | null; key: string | null; reason: string };
  provenance: ProvenanceCheck;
  /** The warning printed before publishing, when the run has no OIDC token. */
  warning: string | null;
  /** The tag the cut made, or null for a release with no label. */
  releaseTag: string | null;
  targets: PublishTarget[];
  /** Masks the run's credentials in what the publish prints. */
  redactor: Redactor;
}

/**
 * Resolve `ref` (a label or a digest) in the member at `cwd` and decide
 * whether it may be published, reading the local `chant/lifecycle` branch,
 * the local tags and the declaration at base. Fetches nothing.
 */
export async function preparePublish(req: { cwd: string; ref: string; env?: NodeJS.ProcessEnv; deps?: PublishDeps }): Promise<PublishPlan | { refusal: PublishRefusal }> {
  const { resolveRelease, readCuts } = await import("./release-store");
  const { readRevokedCommits, revocationOf, describeRevocation } = await import("./release-revocation");
  const { scopeSource } = await import("../workspace/write-scope");
  const { releaseRuleFrom } = await import("../workspace/identity");
  const { checkReleaseSignature } = await import("../workspace/identity-gate-rule");
  const { cwd, ref } = req;
  const found = await resolveRelease(ref, { cwd });
  if (!found) return { refusal: { code: "release-not-found", message: `no release is labelled or digested "${ref}" in this member`, fix: "List them with: chant release list" } };
  const { release, label } = found;
  const name = label ?? release.releaseDigest;

  const revoked = revocationOf(release, await readRevokedCommits(cwd).catch(() => new Map()));
  if (revoked) {
    return {
      refusal: {
        code: "release-revoked",
        message: `${name} was cut from commit ${release.commit.slice(0, 12)}, which ${revoked.tag} revokes: ${describeRevocation(revoked)}`,
        fix: "Cut a release from a later green commit.",
      },
    };
  }

  const rule = releaseRuleFrom(scopeSource(cwd));
  const cuts = (await readCuts({ cwd })).cuts.filter((c) => c.releaseDigest === release.releaseDigest);
  const checks = cuts.map((c) => ({
    cut: c,
    check: checkReleaseSignature(rule.rule, { releaseDigest: c.releaseDigest, label: c.label, actor: c.actor, timestamp: c.timestamp, signature: c.signature }),
  }));
  const verified = checks.find((c) => c.check.status === "verified");
  if (rule.requirement && !verified) {
    const unsigned = checks.every((c) => c.check.status === "unsigned");
    return {
      refusal: {
        code: unsigned ? "release-unsigned" : "release-signature-unverified",
        message: unsigned
          ? `${name} has no signed cut, and identity.gates.release in chant.workspace.json at base publishes only a signed release`
          : `no cut of ${name} carries a signature that counts: ${checks.map((c) => c.check.reason).join("; ")}`,
        fix: `Cut it signed by a signer${rule.requirement.class !== null ? ` in the class ${rule.requirement.class}` : ""}: chant release cut ${label ?? "<label>"} --sign --yes`,
      },
    };
  }
  const shown = verified ?? checks.at(-1);
  const signature: PublishPlan["signature"] = shown
    ? { status: shown.check.status, actor: shown.cut.actor, key: shown.check.key, reason: shown.check.reason }
    : { status: "unsigned", actor: null, key: null, reason: "no cut names the release" };

  let targets: PublishTarget[];
  try {
    targets = await releasePublishTargets(cwd, req.deps);
  } catch (err) {
    return { refusal: { code: "publish-config-invalid", message: `the publish targets can't be read: ${err instanceof Error ? err.message : String(err)}`, fix: "Fix release.publish in chant.config.ts." } };
  }
  // A target publishes files from this checkout, so they must be the release commit's (#4047).
  if (targets.length > 0) {
    const refused = checkCheckoutIsRelease(cwd, release.commit, name);
    if (refused) return { refusal: refused };
  }

  const env = req.env ?? process.env;
  const provenance = detectProvenance(env);
  const warning = provenance.oidc
    ? null
    : `this publish runs without OIDC, so what it publishes carries no provenance: ${provenance.reason}. Publish from CI to get provenance.`;
  const { resolveMemberLedger } = await import("./member-ledger");
  const { releaseTagName } = await import("./release-workstation");
  const ledger = await resolveMemberLedger(cwd).catch(() => ({ members: [] as string[] }));
  const member = ledger.members.length > 0 ? ledger.members.join("/") : null;
  const releaseTag = label !== null ? releaseTagName(member, label) : null;
  const redactor = createRedactor(env, targets.flatMap((t) => t.credentialEnv));
  return { release, label, signature, provenance, warning, releaseTag, targets, redactor };
}

/**
 * A publish with a target reads files from the checkout it runs in: package
 * directories, an image layout, assets. They are the release's only when the
 * checkout is the release's commit with nothing changed, so a publish refuses
 * a `HEAD` that is another commit and a tree with changes git sees. A publish
 * with no target reads nothing and checks neither.
 */
export function checkCheckoutIsRelease(cwd: string, commit: string, name: string): PublishRefusal | null {
  const head = tryGit(cwd, ["rev-parse", "HEAD"]);
  if (head !== commit) {
    return {
      code: "release-head-mismatch",
      message: `${name} was cut from commit ${commit.slice(0, 12)}, but this checkout is at ${head ? head.slice(0, 12) : "no commit"}, so what it would publish is not the release's`,
      fix: `Check out the release's commit, as a CI job on its tag does: git checkout ${commit}`,
    };
  }
  const status = tryGit(cwd, ["status", "--porcelain", "--untracked-files=normal"]);
  if (status) {
    const n = status.split("\n").length;
    return {
      code: "release-worktree-dirty",
      message: `the working tree has ${n} changed or untracked file(s) such as ${status.split("\n")[0]!.slice(3)}, so what a publish reads here is not commit ${commit.slice(0, 12)}'s`,
      fix: "Publish from a clean checkout of the release's commit. Build outputs belong in .gitignore.",
    };
  }
  return null;
}

function tryGit(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** The context each target is planned and published with. */
export function publishContext(plan: PublishPlan, req: { cwd: string; env?: NodeJS.ProcessEnv; tag?: string | null; log: (line: string) => void }): PublishContext {
  return {
    release: plan.release,
    label: plan.label,
    releaseTag: plan.releaseTag,
    provenance: plan.provenance,
    cwd: req.cwd,
    tag: req.tag ?? null,
    env: req.env ?? process.env,
    redactor: plan.redactor,
    log: (line) => req.log(plan.redactor.redact(line)),
  };
}
