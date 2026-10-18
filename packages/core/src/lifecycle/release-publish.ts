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
 * runs. The targets come from {@link releasePublishTargets}. chant has none
 * yet: publish targets and their credentials are #4047, all-or-nothing and
 * resume are #4048, and signing, SBOMs and provenance are #4049. Until then
 * a publish publishes nothing and says so. The publish steps a component
 * declares (`publish-image`, `publish-artifact`, `publish-asset`,
 * `load-image-on-host`) are deploy steps: they run in each environment's
 * deploy of the release (`chant components promote --release`), never here.
 */

import type { Release } from "./release-store";

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

/** What one target published. */
export interface PublishedTarget {
  target: string;
  /** Where it went, such as a registry and a package name. */
  destination: string;
}

/**
 * One place a release is published to (#4047 fills these in). A target
 * publishes the release's artifacts as they were built at the cut, checked
 * against their digests, and never builds.
 */
export interface PublishTarget {
  /** A name for messages, such as `npm @scope/pkg`. */
  name: string;
  /** Where it publishes, for the line printed before it runs. */
  destination: string;
  publish(ctx: { release: Release; label: string | null; provenance: ProvenanceCheck; cwd: string }): Promise<PublishedTarget>;
}

/** The targets a release publishes to. None yet: #4047 declares them. */
export function releasePublishTargets(_release: Release, _cwd: string): PublishTarget[] {
  return [];
}

/** Why a publish was refused before anything ran. */
export interface PublishRefusal {
  code: "release-not-found" | "release-revoked" | "release-unsigned" | "release-signature-unverified";
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
  targets: PublishTarget[];
}

/**
 * Resolve `ref` (a label or a digest) in the member at `cwd` and decide
 * whether it may be published, reading the local `chant/lifecycle` branch,
 * the local tags and the declaration at base. Fetches nothing.
 */
export async function preparePublish(req: { cwd: string; ref: string; env?: NodeJS.ProcessEnv }): Promise<PublishPlan | { refusal: PublishRefusal }> {
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

  const provenance = detectProvenance(req.env ?? process.env);
  const warning = provenance.oidc
    ? null
    : `this publish runs without OIDC, so what it publishes carries no provenance: ${provenance.reason}. Publish from CI to get provenance.`;
  return { release, label, signature, provenance, warning, targets: releasePublishTargets(release, cwd) };
}
