/**
 * Publishing a cut release (#4027): the contract `chant release publish`
 * keeps, and the hook its targets fill in.
 *
 * A publish takes a release by label or digest and, before it publishes
 * anything, refuses:
 *
 * - a release no cut names (`release-not-found`);
 * - a release cut from a revoked commit (`release-revoked`, #4033);
 * - under an `identity.gates` entry for `release` (#4031), a release with no
 *   cut signed by a signer in the gate's class (`release-unsigned` or
 *   `release-signature-unverified`);
 * - when the workspace opts into `verified-releases` (`security` in
 *   chant.workspace.json, #4168), a release none of whose cuts carries a
 *   signature that verifies for its actor against `.chant/allowed_signers`
 *   at base (#4049). `--allow-unsigned` publishes it anyway, with a warning;
 *   it never overrides the release gate.
 *
 * With neither, an unsigned release publishes quietly, and the plan records
 * its `signature` status (#4168: security features are opt-in).
 *
 * It then says whether the run has an OIDC token to sign provenance with
 * ({@link detectProvenance}). Under `supply-chain` it warns when there is
 * none, before any target runs; `--require-provenance` refuses instead
 * (`publish-provenance-missing`). Without either, provenance is only the
 * plan's `provenance` field.
 * When `release.signing` or `supply-chain` asks for Sigstore signing and an
 * OCI, forge or pypi target is declared (#5164, ./publish-signing.ts), a run that
 * can't sign keylessly is refused (`publish-signing-no-oidc`,
 * `publish-signing-tool-missing`).
 * The targets come from {@link releasePublishTargets}: the member declares them under `release.publish` in its `chant.config.ts` (#4047).
 * With a target, the checkout must be the release's commit with a clean
 * tree ({@link checkCheckoutIsRelease}), every target is planned before any
 * publishes, and without `--yes` nothing is published. With `--yes`,
 * {@link runPublish} stages every target, then reveals them (#4048): nothing a
 * consumer resolves changes until every target has staged, and a publish
 * that failed resumes from the record in `_releases/publishes.jsonl`
 * (./publish-record.ts) without publishing again what went out. Each target
 * attaches an SBOM and the release's provenance statement, which carries the
 * cut's signature, when it stages (./publish-attachments.ts, #4049). The
 * publish steps a component declares (`publish-image`, `publish-artifact`, `publish-asset`,
 * `load-image-on-host`) are deploy steps: they run in each environment's
 * deploy of the release (`chant components promote --release`), never here.
 */

import { execFileSync } from "node:child_process";
import type { Release } from "./release-store";
import { stampedChanges, type ReleaseVersionConfig } from "./release-version";
import { createRedactor, type Redactor } from "./publish-credentials";
import { floatingTagOfLine, renderReleaseTag, stableVersionOf, type MemberTags } from "./release-tag";
import { prereleaseOf } from "./release-prerelease";

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
  /** True when the destination refused it and the target turns a refusal into a warning (a marketplace's `onRefusal: "warn"`, #4698), so it was not published. */
  refused?: boolean;
  /**
   * Set on a file attached to what the target publishes: an SBOM or the
   * release's provenance statement (#4049), or a Sigstore bundle (#5164), a
   * `signature` over a file or an image, or an `attestation`, SLSA provenance.
   */
  attachment?: "sbom" | "provenance" | "signature" | "attestation";
  /** On a Sigstore bundle (#5164): what it signs, each name and digest. An image is named `<repository>@<digest>`. */
  signs?: Array<{ name: string; digest: string }>;
  /** On a Sigstore bundle over a statement (#5164): the statement's predicate type. */
  predicateType?: string;
  /** On a Sigstore bundle (#5164): the OIDC issuer and the identity (a regular expression) its certificate was issued to. */
  sigstore?: { issuer: string; identity: string };
  /** The SBOM file an npm package carries at its root (#4049). */
  sbom?: string;
  /** The notes a forge release is given (#4658), which a dry run prints. */
  notes?: string;
}

/** The cut a publish carries the signature of (#4049): the cut whose signature verified, else the newest. */
export interface PublishCut {
  actor: string;
  label: string | null;
  timestamp: string;
  runId: string | null;
  /** The armored ssh signature in the `chant-release` namespace, or null for an unsigned cut. */
  signature: string | null;
  /** The green gate the cut passed (#5149), absent on a cut that recorded none. */
  green?: import("./release-store").ReleaseCutGreen;
  /** The override the cut ran under (#4693), absent on a cut of a green commit. */
  override?: import("./release-store").ReleaseCutOverride;
}

/**
 * What one target staged: its items, out where the target publishes but not
 * where a consumer resolves them yet, and the values its reveal needs that it
 * can't read again from the checkout, such as a draft release's id. The
 * publish record keeps it, so a resume reveals without staging again. It never
 * holds a credential.
 */
export interface StagedTarget {
  target: string;
  destination: string;
  items: PublishItem[];
  state: Record<string, string>;
}

/** What one target published. */
export interface PublishedTarget {
  target: string;
  /** Where it went, such as a registry and a package name. */
  destination: string;
  /** Each thing published, in order. */
  items: PublishItem[];
  /**
   * Set when the destination refused the reveal and the target declares that
   * a warning (#4698): why, with the items `refused`. The publish goes on, and
   * the target is not recorded as revealed, so the same publish run again
   * reveals it again.
   */
  warning?: string;
}

/** Injected into the targets, so tests drive them with fakes. */
export interface PublishDeps {
  /** The HTTP client the OCI, forge, homebrew, marketplace and tauri-updater targets use. Default: the global `fetch`. */
  fetch?: PublishFetch;
  /** The npm executable. Default: `npm` on `PATH`. */
  npm?: string;
  /** The vsce executable the VS Code Marketplace target runs (#4676). Default: `vsce` on `PATH`. */
  vsce?: string;
  /** The cargo executable the cargo target runs (#5167). Default: `cargo` on `PATH`. */
  cargo?: string;
  /** The git executable the homebrew target runs to push over SSH (#4699). Default: `git` on `PATH`. */
  git?: string;
  /** The ssh executable git runs for it (#4699). Default: `ssh` on `PATH`. */
  ssh?: string;
  /** How a target waits between polls of a registry (#4244). Default: a timer. */
  sleep?: (ms: number) => Promise<void>;
  /** The clock a target's wait reads (#4244). Default: `Date.now`. */
  now?: () => number;
  /** What signs with Sigstore (#5164). Default: cosign, run keylessly (./publish-signing.ts). */
  signer?: import("./publish-signing").Signer;
}

/** The subset of the WHATWG `fetch` the targets use. */
export type PublishFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: Uint8Array | string; redirect?: "follow" | "manual" },
) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; text(): Promise<string>; arrayBuffer?(): Promise<ArrayBuffer> }>;

/**
 * The part of a target's context every kind of target is given, whatever it
 * publishes (#4602). A release target gets {@link PublishContext}, which adds
 * the release; a target outside `release.publish`, such as the terraform
 * lexicon's module targets, extends this with its own fields (a module
 * version, its archive) and implements `PublishTarget<ItsContext, string>`,
 * reusing {@link PublishTargetError}, {@link PublishFetch}, {@link PublishDeps}
 * and the credential helpers in ./publish-credentials.ts.
 */
export interface PublishContextBase {
  /** The directory the declaration's paths are relative to. */
  cwd: string;
  /** The environment credentials are read from. */
  env: NodeJS.ProcessEnv;
  /** Masks credentials; every line a target logs and every error it throws goes through it. */
  redactor: Redactor;
  /** Print one line of progress. The line is redacted. */
  log(line: string): void;
  provenance: ProvenanceCheck;
  /**
   * The tag a reveal points at what was staged, in place of the target's
   * own: npm's dist-tag (default `latest`) and the OCI tags. Null for the
   * target's own. Staging never uses it: npm stages under `next`
   * ({@link NPM_STAGE_TAG}) and OCI by digest.
   */
  tag: string | null;
}

/** What a release target is given to plan and to publish. */
export interface PublishContext extends PublishContextBase {
  release: Release;
  label: string | null;
  /** The tag the cut made for the release, from `release.tag` (#5150; default `release/<label>` or `release/<member>/<label>`), or null for a release with no label. */
  releaseTag: string | null;
  /**
   * The tag `release.tag` gives another label of this member (#5150), such
   * as the previous release's, which a forge's generated notes start from.
   * Absent where the template is not known.
   */
  releaseTagOf?: (label: string) => string | null;
  /** The cut whose signature the provenance statement carries (#4049), or null when none is known. */
  cut?: PublishCut | null;
  /** The member's directory, which the declaration's paths are relative to. */
  cwd: string;
  /**
   * Whether a target with no SBOM source refuses (`publish-sbom-missing`),
   * as under the `supply-chain` group (#4168). False or absent: it publishes
   * without an SBOM. A declared `sbom` file is attached either way.
   */
  requireSbom?: boolean;
  /**
   * Set when the publish signs with Sigstore (#5164): the OCI and forge
   * targets sign what they stage with it. Null or absent: nothing is signed.
   */
  signing?: import("./publish-signing").SigningContext | null;
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

/** The kinds `release.publish` declares and `createPublishTargets` makes. */
export type ReleasePublishKind = "npm" | "oci" | "forge" | "homebrew" | "marketplace" | "tauri-updater" | "pypi" | "cargo";

/** The npm dist-tag a set of packages is staged under before `latest` moves (#4048), as chant's own releases do (#3903). */
export const NPM_STAGE_TAG = "next";

/**
 * One place a release is published to (#4047). A target publishes the
 * release's artifacts as they were built at the cut, checked against their
 * digests where the release records them, and never builds. Targets are
 * declared under `release.publish` in the member's `chant.config.ts`
 * (./publish-declaration.ts) and made by `createPublishTargets`
 * (./publish-targets.ts). A new kind of target is a new member of the
 * declaration's union and a factory that returns this interface.
 *
 * The context is a type parameter (#4602): a target that publishes something
 * other than a cut release, such as a module version, implements
 * `PublishTarget<C, K>` over its own context `C`, which extends
 * {@link PublishContextBase}, with its own `kind` names `K`. Such targets are
 * made by their own code, never by `createPublishTargets`.
 */
export interface PublishTarget<C extends PublishContextBase = PublishContext, K extends string = ReleasePublishKind> {
  /** The declaration's `type`: one of {@link ReleasePublishKind} under `release.publish`, any name for a target outside it. */
  kind: K;
  /** A name for messages, such as `npm (2 packages)`. */
  name: string;
  /** Where it publishes, for the line printed before it runs. */
  destination: string;
  /** The environment variables it reads credentials from, whose values are masked in all output. */
  credentialEnv: string[];
  /**
   * Names the declaration across runs, so a resume finds the target's lines
   * in the publish record: the kind and a digest of the declaration, which
   * holds variable names and never a credential.
   */
  key: string;
  /**
   * Read what it would publish and check that it can: the files are there,
   * they match the release's digests, the credentials it needs are set.
   * Uploads nothing and makes no request that changes anything. Throws
   * {@link PublishTargetError}. The dry run prints what it returns, and a
   * publish plans every target before any of them publishes.
   */
  plan(ctx: C): Promise<PublishItem[]>;
  /**
   * Put every item where the target publishes, where no consumer resolves it
   * yet (#4048): npm under the `next` dist-tag, OCI by digest with no tag
   * moved, forge assets on a draft release (GitLab: in the package registry,
   * with no release link). An item the destination already holds is not sent
   * again and comes back `present`, so a stage run again after a failure
   * sends only what is missing. Throws {@link PublishTargetError}.
   */
  stage(ctx: C): Promise<StagedTarget>;
  /**
   * The one last step that makes what {@link stage} put out visible: npm
   * moves `latest` (or `ctx.tag`) package by package in the declared order,
   * the first package first; OCI points the tags at the digest; a forge
   * publishes the draft (GitLab: creates the release with its links). Run
   * again, it moves nothing that already moved. Throws {@link PublishTargetError}.
   */
  reveal(ctx: C, staged: StagedTarget): Promise<PublishedTarget>;
  /**
   * True when {@link stage} already puts the items where a consumer resolves
   * them, so there is nothing to hold back (npm under `stage: false`). A
   * train publish (#5136) stages such a target in its dependency layer's
   * turn, after the layers before it are visible, instead of up front.
   */
  stagesVisibly?: boolean;
  /**
   * True when {@link stage} sends nothing and {@link reveal} is the upload,
   * because the destination has no place to hold a release unseen (a
   * marketplace, PyPI, a Cargo registry, #5167). Nothing of it is out
   * between the two steps, so a check of what staged can't see it.
   */
  uploadsAtReveal?: boolean;
  /**
   * The names this target publishes and the names of others' it depends on
   * (npm: the package names, and every `dependencies`, `peerDependencies`
   * and `optionalDependencies` key). A train publish orders its members by
   * them (#5136). Absent: the target neither provides nor needs anything.
   */
  names?(ctx: C): Promise<{ provides: string[]; needs: string[] }>;
  /**
   * Whether the destination already serves what this target publishes for
   * `ctx.label`, read without checking digests, since the checkout need not
   * be the release's commit (#5136): true, false, or null when it can't tell.
   * A train publish asks it of a member pinned at an earlier release whose
   * publish record does not show it revealed.
   */
  published?(ctx: C): Promise<boolean | null>;
  /**
   * Wait until a consumer resolving the reveal's tag gets what `published`
   * holds (npm: `dist-tags.latest` names the version). A train publish waits
   * on each dependency layer before the next one reveals (#5136). Throws
   * {@link PublishTargetError}.
   */
  visible?(ctx: C, published: PublishedTarget): Promise<void>;
  /**
   * Deprecate, yank or restore what this target published for a release
   * (#5163), from the publish record's items, never from the checkout. With
   * `ctx.apply` false it asks nothing and says what it would do. Each
   * action that is already so comes back `already`; one the destination
   * can't do comes back `refused`. Run again, it sends nothing that is
   * already so. Absent: the target refuses every status change.
   */
  setStatus?(ctx: StatusContext): Promise<StatusAction[]>;
}

/** How a yank leaves the forge release (#5163): marked a prerelease, made a draft again, or deleted. */
export type ForgeYankMode = "prerelease" | "draft" | "delete";

/** One release as a status change sees it on one target: what its publish revealed there. */
export interface StatusRelease {
  releaseDigest: string;
  label: string | null;
  /** The tag its cut made, or null for a release with no label. */
  releaseTag: string | null;
  /** The items the publish record says its reveal published on the target. */
  items: PublishItem[];
}

/**
 * What a target is given to deprecate, yank or restore a published release
 * (#5163). It reads no file in the checkout: what went out is the publish
 * record's, so a status change runs from any checkout of the member.
 */
export interface StatusContext extends PublishContextBase {
  release: Release;
  label: string | null;
  releaseTag: string | null;
  /** The status being set: `deprecated`, `yanked`, or `active` to restore. */
  status: "active" | "deprecated" | "yanked";
  /** Why, as the person gave it, or null. */
  reason: string | null;
  /** The release to move to instead, as the person named it, or null. */
  replacement: string | null;
  /** What this release's publish revealed on the target. */
  revealed: PublishItem[];
  /**
   * The release the target's moving tags (npm's dist-tag, OCI tags with no
   * `{label}`, a tap's formula, GitHub's latest) should point at once the
   * status is set: the newest release of the same channel whose status is
   * active, that is not revoked and that was revealed on this target. It is
   * this release on a restore when nothing newer is active, and null when
   * there is none.
   */
  head: StatusRelease | null;
  /** How a yank leaves a forge release. */
  forgeYank: ForgeYankMode;
  /** False for a dry run: describe what would be done and make no request. */
  apply: boolean;
}

/** One thing a status change does, or would do, on a target. */
export interface StatusAction {
  /** What, in a line: `npm deprecate @acme/core@1.4.0`. */
  what: string;
  /** True when the destination was already so, and nothing was sent. */
  already?: boolean;
  /** Set when the target can't do it: why, with a code, and nothing was sent for it. */
  refused?: { code: string; message: string; fix?: string };
}

/** The deprecation message a status change gives a version: the reason, and the release to use instead. */
export function statusMessage(ctx: Pick<StatusContext, "status" | "reason" | "replacement">): string {
  const lead = ctx.status === "yanked" ? "yanked" : "deprecated";
  return [ctx.reason ? `${lead}: ${ctx.reason}` : lead, ctx.replacement ? `use ${ctx.replacement}` : null].filter(Boolean).join("; ");
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
    | "publish-provenance-missing"
    | "publish-signing-no-oidc"
    | "publish-signing-tool-missing"
    | "publish-config-invalid"
    | "release-head-mismatch"
    | "release-worktree-dirty"
    | "release-tag-template-invalid"
    | "release-tag-collision";
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
  /** The warning printed before publishing, when the run has no OIDC token and the workspace opts into `supply-chain` (#4168). */
  warning: string | null;
  /** The warning printed before publishing a release with no verified signature under `--allow-unsigned` (#4049). */
  signatureWarning: string | null;
  /** The cut whose signature the provenance statement carries: the verified one, else the newest. */
  cut: PublishCut | null;
  /** The tag the cut made, or null for a release with no label. */
  releaseTag: string | null;
  /** The tag the member's `release.tag` gives another label (#5150). */
  releaseTagOf?: (label: string) => string | null;
  /** The floating tag `release.tag.floating` names (#5150), and whether this release moves it; null when there is none. */
  floating?: FloatingTag | null;
  targets: PublishTarget[];
  /** Masks the run's credentials in what the publish prints. */
  redactor: Redactor;
  /** Whether a target with no SBOM source is refused (`publish-sbom-missing`): the workspace opts into `supply-chain` (#4168). Otherwise it publishes without one. */
  requireSbom: boolean;
  /** The channel a cut of the release names (#4168 4.3), the tag moved in place of `latest`, or null. */
  channel: string | null;
  /** What the OCI and forge targets sign with (#5164), or null when the publish does not sign. */
  signing: import("./publish-signing").SigningContext | null;
  /** The warning printed when the `supply-chain` group asks for signing and `release.signing: false` turns it off. */
  signingWarning: string | null;
}

/**
 * Resolve `ref` (a label or a digest) in the member at `cwd` and decide
 * whether it may be published, reading the local `chant/lifecycle` branch,
 * the local tags and the declaration at base. Fetches nothing.
 *
 * `allowUnsigned` publishes a release with no verified signature, which
 * `verified-releases` refuses otherwise (#4049, #4168); it does not override
 * the release gate. `requireProvenance` refuses a run with no OIDC token,
 * where `supply-chain` warns and no group says nothing.
 */
export async function preparePublish(req: {
  cwd: string;
  ref: string;
  env?: NodeJS.ProcessEnv;
  deps?: PublishDeps;
  allowUnsigned?: boolean;
  requireProvenance?: boolean;
}): Promise<PublishPlan | { refusal: PublishRefusal }> {
  const { resolveRelease, readCuts } = await import("./release-store");
  const { readRevokedCommits, revocationOf, describeRevocation } = await import("./release-revocation");
  const { scopeSource } = await import("../workspace/write-scope");
  const { releaseRuleFrom } = await import("../workspace/identity");
  const { checkReleaseSignature } = await import("../workspace/identity-gate-rule");
  const { securityGroupsIn } = await import("../workspace/security");
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

  const source = scopeSource(cwd);
  const rule = releaseRuleFrom(source);
  const groups = securityGroupsIn(source, cwd);
  const cuts = (await readCuts({ cwd })).cuts.filter((c) => c.releaseDigest === release.releaseDigest);
  const checks = cuts.map((c) => ({
    cut: c,
    check: checkReleaseSignature(rule.rule, { releaseDigest: c.releaseDigest, label: c.label, actor: c.actor, timestamp: c.timestamp, signature: c.signature }),
  }));
  const verified = checks.find((c) => c.check.status === "verified");
  const unsigned = checks.every((c) => c.check.status === "unsigned");
  if (rule.requirement && !verified) {
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
  // #4049, #4168: under verified-releases a publish refuses a release whose signature does not verify, unless --allow-unsigned. Without it an unsigned release publishes quietly.
  let signatureWarning: string | null = null;
  if (!verified && groups.has("verified-releases")) {
    const why = unsigned
      ? `${name} has no signed cut`
      : `no cut of ${name} carries a signature that verifies against the signers file at base: ${checks.map((c) => c.check.reason).join("; ")}`;
    if (!req.allowUnsigned) {
      return {
        refusal: {
          code: unsigned ? "release-unsigned" : "release-signature-unverified",
          message: `${why}, and the workspace opts into verified-releases (security in chant.workspace.json), which publishes only a release signed by a key in .chant/allowed_signers`,
          fix: `Cut it signed with a key .chant/allowed_signers lists for the chant-release namespace: chant release cut ${label ?? "<label>"} --sign --yes. To publish it unsigned anyway, pass --allow-unsigned.`,
        },
      };
    }
    signatureWarning = `${why}; publishing it anyway under --allow-unsigned, so chant release verify ${label ?? release.releaseDigest} will fail for it`;
  }
  const shown = verified ?? checks.at(-1);
  const signature: PublishPlan["signature"] = shown
    ? { status: shown.check.status, actor: shown.cut.actor, key: shown.check.key, reason: shown.check.reason }
    : { status: "unsigned", actor: null, key: null, reason: "no cut names the release" };
  const cut: PublishCut | null = shown
    ? {
        actor: shown.cut.actor,
        label: shown.cut.label,
        timestamp: shown.cut.timestamp,
        runId: shown.cut.runId ?? null,
        signature: shown.cut.signature ?? null,
        ...(shown.cut.green ? { green: shown.cut.green } : {}),
        ...(shown.cut.override ? { override: shown.cut.override } : {}),
      }
    : null;

  let targets: PublishTarget[];
  try {
    targets = await releasePublishTargets(cwd, req.deps);
  } catch (err) {
    return { refusal: { code: "publish-config-invalid", message: `the publish targets can't be read: ${err instanceof Error ? err.message : String(err)}`, fix: "Fix release.publish in chant.config.ts." } };
  }
  // A target publishes files from this checkout, so they must be the release commit's (#4047).
  if (targets.length > 0) {
    // #4840: the files release.version names may carry the label, as the publish job's `chant release stamp` writes them.
    const { loadChantConfig } = await import("../config");
    const version = (await loadChantConfig(cwd)).config.release?.version;
    const trains = version?.ranges === "train" && label !== null ? (await import("../workspace/train-range-labels")).trainLabelCandidates(cwd, label) : undefined;
    const refused = checkCheckoutIsRelease(cwd, release.commit, name, version ? { version, label, ...(trains ? { trains: await trains } : {}) } : {});
    if (refused) return { refusal: refused };
  }

  const env = req.env ?? process.env;
  const provenance = detectProvenance(env);
  if (req.requireProvenance && !provenance.oidc) {
    return {
      refusal: {
        code: "publish-provenance-missing",
        message: `${name} would be published without OIDC provenance, and --require-provenance asks for it: ${provenance.reason}`,
        fix: "Publish from a CI job that has an OIDC token (GitHub Actions: permissions: id-token: write), or drop --require-provenance.",
      },
    };
  }
  const warning = provenance.oidc || !groups.has("supply-chain")
    ? null
    : `this publish runs without OIDC, so what it publishes carries no provenance: ${provenance.reason}. Publish from CI to get provenance.`;
  // #5164: Sigstore signing, when release.signing or supply-chain asks for it and a target signs.
  const { resolveSigning, signingIdentity, cosignSigner } = await import("./publish-signing");
  const { loadChantConfig: loadConfig } = await import("../config");
  const signingConfig = (await loadConfig(cwd).catch(() => null))?.config.release?.signing;
  const setting = resolveSigning(signingConfig, groups);
  let signing: PublishPlan["signing"] = null;
  const signs = targets.filter((t) => t.kind === "oci" || t.kind === "forge" || t.kind === "pypi");
  if (setting.on && signs.length > 0) {
    const why = setting.from === "config" ? "release.signing in chant.config.ts" : "the supply-chain group";
    const id = signingIdentity(env);
    if ("reason" in id) {
      return {
        refusal: {
          code: "publish-signing-no-oidc",
          message: `${name} would be signed with Sigstore, as ${why} asks, and this run can't sign keylessly: ${id.reason}`,
          fix: "Publish from a CI job with an OIDC token (GitHub Actions: permissions: id-token: write; GitLab CI: SIGSTORE_ID_TOKEN under id_tokens with aud: sigstore), or set release.signing: false.",
        },
      };
    }
    const signer = req.deps?.signer ?? cosignSigner(env, createRedactor(env));
    const missing = signer.unavailable();
    if (missing) {
      return {
        refusal: {
          code: "publish-signing-tool-missing",
          message: `${name} would be signed with Sigstore, as ${why} asks, and ${missing}`,
          fix: "Install cosign 3 in the job, as chant release workflow does, or point CHANT_COSIGN at it.",
        },
      };
    }
    signing = { signer, identity: id.identity };
  }
  // #5150: the tag release.tag gives the label, as the cut made it, and the floating tag the publish moves.
  const { memberTags, ReleaseTagError } = await import("./release-tag");
  let tags: MemberTags;
  try {
    tags = await memberTags(cwd);
  } catch (err) {
    if (err instanceof ReleaseTagError) return { refusal: { code: err.code, message: err.message, ...(err.fix ? { fix: err.fix } : {}) } };
    const { legacyTagTemplate } = await import("./release-tag");
    tags = { place: { member: null, path: null }, template: { name: legacyTagTemplate(null), floating: null, legacy: true } };
  }
  let releaseTag: string | null;
  try {
    releaseTag = label !== null ? renderReleaseTag(tags.template, tags.place, label) : null;
  } catch (err) {
    if (err instanceof ReleaseTagError) return { refusal: { code: err.code, message: err.message, ...(err.fix ? { fix: err.fix } : {}) } };
    throw err;
  }
  const redactor = createRedactor(env, targets.flatMap((t) => t.credentialEnv));
  const channel = [...cuts].reverse().find((c) => c.channel)?.channel ?? null;
  const floating = label !== null ? floatingTagPlan(tags, label, release.commit, channel, (await readCuts({ cwd })).cuts.map((c) => c.label).filter((l): l is string => l !== null)) : null;
  const releaseTagOf = (other: string): string | null => {
    try {
      return renderReleaseTag(tags.template, tags.place, other);
    } catch {
      return null;
    }
  };
  return { release, label, signature, provenance, warning, signatureWarning, cut, releaseTag, releaseTagOf, floating, targets, redactor, requireSbom: groups.has("supply-chain"), channel, signing, signingWarning: setting.warning };
}

/**
 * A publish with a target reads files from the checkout it runs in: package
 * directories, an image layout, assets. They are the release's only when the
 * checkout is the release's commit with nothing changed, so a publish refuses
 * a `HEAD` that is another commit and a tree with changes git sees. A publish
 * with no target reads nothing and checks neither.
 *
 * Under `release.version` (#4840), a file it names that is exactly the
 * commit's stamped with the release's label is the commit's too.
 */
export function checkCheckoutIsRelease(
  cwd: string,
  commit: string,
  name: string,
  o: { version?: ReleaseVersionConfig; label?: string | null; trains?: readonly import("./release-version").RangeLabels[] } = {},
): PublishRefusal | null {
  const head = tryGit(cwd, ["rev-parse", "HEAD"]);
  if (head !== commit) {
    return {
      code: "release-head-mismatch",
      message: `${name} was cut from commit ${commit.slice(0, 12)}, but this checkout is at ${head ? head.slice(0, 12) : "no commit"}, so what it would publish is not the release's`,
      fix: `Check out the release's commit, as a CI job on its tag does: git checkout ${commit}`,
    };
  }
  let status = tryGit(cwd, ["status", "--porcelain", "--untracked-files=normal"]);
  if (status && o.version) status = withoutStamps(cwd, commit, o.version, o.label ?? null, status, o.trains);
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

/** The porcelain status without the files {@link stampedChanges} takes as the commit's stamped with the label. */
function withoutStamps(cwd: string, commit: string, version: ReleaseVersionConfig, label: string | null, status: string, trains?: readonly import("./release-version").RangeLabels[]): string {
  let raw: string;
  let top: string;
  try {
    raw = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return status;
  }
  const stamped = stampedChanges({ cwd, top, commit, config: version, label, status: raw, ...(trains ? { trains } : {}) });
  return raw
    .split("\n")
    .filter((l) => l.length > 0 && !stamped.has(l.slice(3)))
    .join("\n")
    .trim();
}

function tryGit(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** A floating tag (#5150), such as `v1`, and whether the publish moves it to the release's commit once every target has revealed. */
export interface FloatingTag {
  name: string;
  commit: string;
  /** True when the publish moves it; false with `reason` when it leaves it. */
  move: boolean;
  reason: string | null;
}

/**
 * Whether a release labelled `label` moves the member's floating tag: only
 * a stable version, cut with no channel, whose version is the highest of its
 * major among the member's labels, so a fix to an older line never moves
 * `v1` back. A prerelease label leaves it where it is. Null when the member
 * declares no floating tag or the label names no version.
 */
export function floatingTagPlan(tags: MemberTags, label: string, commit: string, channel: string | null, labels: readonly string[]): FloatingTag | null {
  const name = floatingTagOfLine(tags.template, tags.place, label);
  if (name === null) return null;
  const leave = (reason: string): FloatingTag => ({ name, commit, move: false, reason });
  // #5166: the prerelease check every publish target makes; a prerelease never moves the floating tag.
  if (prereleaseOf(label) !== null) return leave(`${label} is a prerelease, and only a stable version moves it`);
  const version = stableVersionOf(label);
  if (version === null) return null;
  if (channel !== null) return leave(`the release was cut for the channel ${channel}, not latest`);
  const cmp = (a: readonly number[], b: readonly number[]) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
  const newer = labels.map((l) => ({ l, v: stableVersionOf(l) })).find((o) => o.v !== null && o.v[0] === version[0] && cmp(o.v, version) > 0);
  if (newer) return leave(`${newer.l} is a later release of major ${version[0]}`);
  if (labels.some((l) => renderReleaseTag(tags.template, tags.place, l) === name)) return leave(`the release labelled ${labels.find((l) => renderReleaseTag(tags.template, tags.place, l) === name)} has the tag ${name}`);
  return { name, commit, move: true, reason: null };
}

/**
 * Move the floating tag to the release's commit, here and on `remote`
 * (#5150). Returns a warning when it could not, naming the commands to run
 * by hand; the release is published either way.
 */
export function moveFloatingTag(cwd: string, floating: FloatingTag, remote = "origin"): string | null {
  const run = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    run(["tag", "-f", floating.name, floating.commit]);
  } catch (err) {
    return `the floating tag ${floating.name} was not moved: ${err instanceof Error ? err.message.trim() : String(err)}. Move it by hand: git tag -f ${floating.name} ${floating.commit} && git push --force ${remote} refs/tags/${floating.name}`;
  }
  try {
    run(["push", "--force", remote, `refs/tags/${floating.name}`]);
  } catch (err) {
    return `the floating tag ${floating.name} was moved here and not pushed: ${err instanceof Error ? err.message.trim() : String(err)}. Push it: git push --force ${remote} refs/tags/${floating.name}`;
  }
  return null;
}

/** The context each target is planned and published with. */
export function publishContext(plan: PublishPlan, req: { cwd: string; env?: NodeJS.ProcessEnv; tag?: string | null; log: (line: string) => void }): PublishContext {
  return {
    release: plan.release,
    label: plan.label,
    releaseTag: plan.releaseTag,
    ...(plan.releaseTagOf ? { releaseTagOf: plan.releaseTagOf } : {}),
    provenance: plan.provenance,
    cut: plan.cut,
    cwd: req.cwd,
    tag: req.tag ?? null,
    env: req.env ?? process.env,
    redactor: plan.redactor,
    log: (line) => req.log(plan.redactor.redact(line)),
    requireSbom: plan.requireSbom,
    signing: plan.signing,
  };
}

/** What {@link runPublish} did. */
export interface PublishRun {
  /** Each target, revealed, in the order declared. */
  published: PublishedTarget[];
  /** The targets an earlier run had staged or revealed, so this one did not stage them again. */
  resumed: Array<{ target: string; step: "staged" | "revealed" }>;
  /** Why a record line was not written or not pushed, when one wasn't. A resume then asks the registries. */
  recordWarning: string | null;
}

/** A publish that stopped, with what it left staged and revealed so a run of the same command resumes. */
export class PublishRunError extends PublishTargetError {
  constructor(
    code: string,
    message: string,
    fix: string | undefined,
    readonly step: "stage" | "reveal",
    readonly staged: string[],
    readonly revealed: string[],
  ) {
    super(code, message, fix);
    this.name = "PublishRunError";
  }
}

/**
 * Publish `targets` all or nothing (#4048), from the record of earlier runs:
 *
 * 1. Stage every target in the order declared, skipping one the record says
 *    staged or revealed. Each stage is recorded and pushed as it finishes.
 *    A failure here leaves nothing visible to a consumer.
 * 2. Only when every target has staged, reveal each in the same order,
 *    skipping one the record says revealed, and record each reveal.
 *
 * A run of the same publish after a failure resumes: what went out is not
 * published again, and a stage that failed part way sends only what its
 * destination does not hold. Throws {@link PublishRunError}.
 */
export async function runPublish(req: {
  cwd: string;
  release: Release;
  label: string | null;
  targets: readonly PublishTarget[];
  ctx: PublishContext;
  /** Write the record. Default true. */
  record?: boolean;
  /** Print one line of progress. Redacted by the caller. */
  say?: (line: string) => void;
  now?: () => Date;
}): Promise<PublishRun> {
  const { appendPublishRecord, publishProgress, readPublishRecords } = await import("./publish-record");
  const { pushLifecycleReport } = await import("./git");
  const { resolveRunId } = await import("./release-ledger");
  const { cwd, release, label, targets, ctx } = req;
  const say = req.say ?? (() => undefined);
  const now = req.now ?? (() => new Date());
  const record = req.record ?? true;
  const runId = resolveRunId(undefined, ctx.env).runId;
  const progress = publishProgress(await readPublishRecords(release.releaseDigest, { cwd }).catch(() => []));
  let recordWarning: string | null = null;

  const write = async (target: PublishTarget, step: "staged" | "revealed", items: PublishItem[], state: Record<string, string>) => {
    if (!record) return;
    try {
      await appendPublishRecord(
        { version: 1, releaseDigest: release.releaseDigest, label, target: target.key, kind: target.kind, name: target.name, step, items, state, runId, timestamp: now().toISOString() },
        ctx.redactor,
        { cwd },
      );
      const push = await pushLifecycleReport({ cwd });
      if (push.pushWarning && recordWarning === null) recordWarning = push.pushWarning;
    } catch (err) {
      recordWarning ??= `the publish record was not written: ${err instanceof Error ? err.message : String(err)}`;
    }
  };
  const fail = (err: unknown, target: PublishTarget, step: "stage" | "reveal", staged: string[], revealed: string[]): never => {
    const e = err instanceof PublishTargetError ? err : new PublishTargetError("publish-failed", err instanceof Error ? err.message : String(err));
    throw new PublishRunError(e.code, ctx.redactor.redact(`${target.name}: ${e.message}`), e.fix, step, staged, revealed);
  };

  const resumed: PublishRun["resumed"] = [];
  const staged = new Map<string, StagedTarget>();
  const stagedNames: string[] = [];
  for (const target of targets) {
    if (progress.revealed.has(target.key)) {
      resumed.push({ target: target.name, step: "revealed" });
      say(`  ${target.name}: published by an earlier run; skipped`);
      continue;
    }
    const earlier = progress.staged.get(target.key);
    if (earlier) {
      resumed.push({ target: target.name, step: "staged" });
      say(`  ${target.name}: staged by an earlier run; not staged again`);
      staged.set(target.key, { ...earlier, target: target.name, destination: target.destination });
      stagedNames.push(target.name);
      continue;
    }
    say(`  staging to ${target.destination}`);
    let s: StagedTarget;
    try {
      s = await target.stage(ctx);
    } catch (err) {
      return fail(err, target, "stage", stagedNames, []);
    }
    staged.set(target.key, s);
    stagedNames.push(target.name);
    await write(target, "staged", s.items, s.state);
  }

  const published: PublishedTarget[] = [];
  const revealedNames: string[] = [];
  for (const target of targets) {
    const done = progress.revealed.get(target.key);
    if (done) {
      published.push({ ...done, target: target.name, destination: target.destination, items: done.items.map((i) => ({ ...i, present: true })) });
      revealedNames.push(target.name);
      continue;
    }
    say(`  revealing ${target.name}`);
    let p: PublishedTarget;
    try {
      p = await target.reveal(ctx, staged.get(target.key)!);
    } catch (err) {
      return fail(err, target, "reveal", stagedNames, revealedNames);
    }
    published.push(p);
    if (p.warning) {
      // Refused, and the target makes that a warning (#4698): not recorded, so a run of the same publish tries it again.
      say(`  warning: ${target.name}: ${p.warning}`);
      continue;
    }
    revealedNames.push(target.name);
    await write(target, "revealed", p.items, {});
  }
  return { published, resumed, recordWarning };
}
