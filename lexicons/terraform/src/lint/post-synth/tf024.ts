/**
 * TF024: a live root declares a `backend` or `cloud` block.
 *
 * choudoufu refuses this combination at `init`, before any command runs,
 * naming both blocks that collide: "Both a backend and a live configuration
 * are present" (a `backend` block) or "Both a cloud and a live configuration
 * are present" (a `cloud` block). A live root keeps no state to store, since
 * prior state is a projection rebuilt from the live system every run, so
 * either block is a contradiction about where the truth lives, not a
 * redundant setting.
 *
 * TF001 is the equivalent check for a stock root (no remote backend is
 * configured); it explicitly does not fire on a live root, and this check is
 * why: the two are mutually exclusive by construction; a root is flagged by
 * at most one of them.
 *
 * Scope: root modules only (#2112). A child module's backend or cloud block
 * is TF015's finding, whatever binary the root runs.
 *
 * One diagnostic per root, fired from the root's `terraform` block.
 */

import type {
  PostSynthCheck,
  PostSynthContext,
  PostSynthDiagnostic,
} from "@intentius/chant/lint/post-synth";
import { isResourceDeclarable } from "@intentius/chant/declarable";
import { TERRAFORM_TYPE, type BlockBody } from "../../hcl/parse";
import { hasBlock } from "./tf001";
import { isRootScoped } from "./scope";

export const tf024: PostSynthCheck = {
  id: "TF024",
  description: "Live root declares a backend or cloud block, which choudoufu refuses",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    const flagged = new Set<string>();

    for (const [name, entity] of ctx.entities) {
      if (entity.entityType !== TERRAFORM_TYPE) continue;
      if (!isResourceDeclarable(entity) || !isRootScoped(entity)) continue;
      const props = entity.props as { root?: unknown; body?: unknown; mode?: unknown };
      if (props.mode !== "live") continue;
      const root = typeof props.root === "string" ? props.root : "";
      if (flagged.has(root)) continue;

      const body = (typeof props.body === "object" && props.body !== null ? props.body : {}) as BlockBody;
      const hasBackend = hasBlock(body, "backend");
      const hasCloud = hasBlock(body, "cloud");
      if (!hasBackend && !hasCloud) continue;

      flagged.add(root);
      const blockKind = hasBackend ? "backend" : "cloud";
      diagnostics.push({
        checkId: "TF024",
        severity: "error",
        message:
          `Root module "${root}" runs choudoufu with a declared estate and also declares a ` +
          `${blockKind} block. choudoufu refuses this at init: "Both a ${blockKind} and a live ` +
          `configuration are present." Remove the ${blockKind} block; a live root keeps no state to store.`,
        entity: name,
        lexicon: "terraform",
      });
    }

    return diagnostics;
  },
};
