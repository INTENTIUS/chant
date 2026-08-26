/**
 * GHA059: Stale or Missing Pin Annotation
 *
 * A ref pinned to a commit SHA is only as trustworthy as the label a reviewer
 * reads next to it — `uses: actions/setup-node@1a2b…9a0b # v4.0.2` lets a
 * reviewer sanity-check the digest without resolving it themselves. This check
 * flags two ways that label goes stale:
 *
 *  1. Missing — a SHA-pinned ref with no trailing version comment at all.
 *  2. Mismatched — inferred without any network call, from internal
 *     inconsistency in the workflow itself: the same action is pinned to the
 *     same commit SHA in one place and a *different* label in another, or the
 *     same label is attached to two *different* commit SHAs. Either shape
 *     proves at least one of the labels is wrong — a real digest has exactly
 *     one correct human-readable name.
 *
 * Cross-referencing a label against the actual git history (to catch a lone,
 * internally-consistent but still-wrong annotation) needs a network call and
 * is out of scope here — see GHA062 for the feed-based advisory check, which
 * takes the same "no network in the rule itself" stance via an injected feed.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractActionRefs, extractUsesComment, parseActionUses } from "./yaml-helpers";

const SHA_RE = /^[0-9a-f]{40}$/;

export interface StalePinFinding {
  job: string;
  ref: string;
  slug: string;
  sha: string;
  kind: "missing" | "mismatched";
  /** For "mismatched": the other label/SHA this one conflicts with. */
  conflict?: string;
}

/**
 * Find every SHA-pinned `uses:` with a missing or internally-inconsistent
 * version annotation. Scoped to one workflow document — cross-file
 * consistency isn't attempted since two independent workflows pinning the
 * same action differently isn't evidence of drift.
 */
export function findStalePinAnnotations(yaml: string): StalePinFinding[] {
  const refs = extractActionRefs(yaml)
    .map(({ job, ref }) => ({ job, ref, parsed: parseActionUses(ref) }))
    .filter((r): r is { job: string; ref: string; parsed: NonNullable<ReturnType<typeof parseActionUses>> } => !!r.parsed && SHA_RE.test(r.parsed.gitRef));

  const findings: StalePinFinding[] = [];

  // First pass: missing annotations.
  const withComment: Array<{ job: string; ref: string; slug: string; sha: string; comment: string }> = [];
  for (const { job, ref, parsed } of refs) {
    const comment = extractUsesComment(ref);
    if (!comment) {
      findings.push({ job, ref, slug: parsed.slug, sha: parsed.gitRef, kind: "missing" });
    } else {
      withComment.push({ job, ref, slug: parsed.slug, sha: parsed.gitRef, comment });
    }
  }

  // Second pass: internal mismatch. Group by slug — the same action's
  // commit-SHA↔label mapping must be one-to-one across the whole file.
  const bySlug = new Map<string, Array<{ job: string; ref: string; slug: string; sha: string; comment: string }>>();
  for (const entry of withComment) {
    const list = bySlug.get(entry.slug) ?? [];
    list.push(entry);
    bySlug.set(entry.slug, list);
  }

  for (const [, entries] of bySlug) {
    const shaToComments = new Map<string, Set<string>>();
    const commentToShas = new Map<string, Set<string>>();
    for (const e of entries) {
      (shaToComments.get(e.sha) ?? shaToComments.set(e.sha, new Set()).get(e.sha)!).add(e.comment);
      (commentToShas.get(e.comment) ?? commentToShas.set(e.comment, new Set()).get(e.comment)!).add(e.sha);
    }
    for (const e of entries) {
      const otherComments = [...(shaToComments.get(e.sha) ?? [])].filter((c) => c !== e.comment);
      const otherShas = [...(commentToShas.get(e.comment) ?? [])].filter((s) => s !== e.sha);
      if (otherComments.length > 0) {
        findings.push({
          job: e.job,
          ref: e.ref,
          slug: e.slug,
          sha: e.sha,
          kind: "mismatched",
          conflict: `commit ${e.sha} is also annotated "# ${otherComments[0]}" elsewhere`,
        });
      } else if (otherShas.length > 0) {
        findings.push({
          job: e.job,
          ref: e.ref,
          slug: e.slug,
          sha: e.sha,
          kind: "mismatched",
          conflict: `label "# ${e.comment}" is also attached to commit ${otherShas[0]} elsewhere`,
        });
      }
    }
  }

  return findings;
}

export const gha059: PostSynthCheck = {
  id: "GHA059",
  description: "SHA-pinned action reference has a missing or internally-inconsistent version annotation",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      for (const finding of findStalePinAnnotations(yaml)) {
        const message =
          finding.kind === "missing"
            ? `Job "${finding.job}" pins ${finding.ref} to a commit SHA with no trailing version comment (e.g. "# v4.0.2") — add one so reviewers can sanity-check the digest.`
            : `Job "${finding.job}" pins ${finding.ref} whose annotation is internally inconsistent (${finding.conflict}) — one of these labels no longer matches the digest it's attached to.`;
        diagnostics.push({
          checkId: "GHA059",
          severity: "warning",
          message,
          entity: finding.job,
          lexicon: "github",
        });
      }
    }

    return diagnostics;
  },
};
