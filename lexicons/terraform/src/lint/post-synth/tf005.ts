/**
 * TF005: a git or hg `module` source with no `?ref=`, or a `?ref=` that
 * isn't tight enough to call pinned.
 *
 * "Git or hg" is `classifyModuleSource`'s `"git"` kind (`./module-source.ts`):
 * an explicit `git::`/`hg::` prefix, the bare `github.com`/`bitbucket.org`
 * shorthands, an scp-style `git@host:path`, or anything ending in `.git`.
 * A ref counts as pinned only if it is a semver-shaped tag or a full 40-hex
 * commit SHA (`isPinnedRef`), stricter than checkov's `CKV_TF_1`/`CKV_TF_2`,
 * which accept any `?ref=` containing `\d\.\d` (so `v1.2-dev` passes there;
 * it does not here, and the rule's page section says so). A ref matching a
 * well-known mutable branch name (`main`, `master`, `develop`, `trunk`) gets
 * its own, more specific message, since that's the exact case tflint's
 * `flexible` style (the style this rule ships; see the page section for what
 * `semver` style would add) already reports on.
 *
 * A local (`./`, `../`) source is never flagged: it can't be pinned to a
 * ref at all, and checkov's own module-pinning checks return `UNKNOWN`
 * (not a failure) for the same reason. A registry source is TF004's
 * territory, not this rule's; the two never fire on the same module block.
 */

import type {
  PostSynthCheck,
  PostSynthContext,
  PostSynthDiagnostic,
} from "@intentius/chant/lint/post-synth";
import { isResourceDeclarable } from "@intentius/chant/declarable";
import { MODULE_TYPE, type BlockBody } from "../../hcl/parse";
import { classifyModuleSource, isDefaultBranch, isPinnedRef } from "./module-source";

export const tf005: PostSynthCheck = {
  id: "TF005",
  description: "Git/hg module source is unpinned, or pinned to a mutable ref",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [key, entity] of ctx.entities) {
      if (entity.entityType !== MODULE_TYPE || !isResourceDeclarable(entity)) continue;
      const props = entity.props as { address?: unknown; body?: unknown };
      const body = (typeof props.body === "object" && props.body !== null ? props.body : {}) as BlockBody;
      const source = typeof body.source === "string" ? body.source : undefined;
      if (source === undefined) continue;

      const classified = classifyModuleSource(source);
      if (classified.kind !== "git") continue;

      const address = typeof props.address === "string" ? props.address : key;
      let message: string | undefined;

      if (!classified.ref) {
        message = `Module "${address}" sources "${source}" from git/hg with no \`?ref=\`. Add one pinned to a tag or a full commit SHA.`;
      } else if (isDefaultBranch(classified.ref)) {
        message = `Module "${address}" sources "${source}" pinned to "${classified.ref}", a mutable branch. Pin to a tag or a full commit SHA instead.`;
      } else if (!isPinnedRef(classified.ref)) {
        message = `Module "${address}" sources "${source}" pinned to "${classified.ref}", which is neither a tag nor a full commit SHA and can move. Pin to a tag or a full commit SHA instead.`;
      }

      if (!message) continue;
      diagnostics.push({
        checkId: "TF005",
        severity: "warning",
        message,
        entity: key,
        lexicon: "terraform",
      });
    }

    return diagnostics;
  },
};
