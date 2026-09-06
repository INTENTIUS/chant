/**
 * TF001: a root module keeps its state on local disk.
 *
 * A `terraform` block with no `backend "<type>"` and no `cloud {}` falls back
 * to the local backend, which puts `terraform.tfstate` in the working
 * directory. That file holds every attribute of every managed resource,
 * secrets included, and it is not shared, not locked, and not versioned. The
 * first apply from a second machine or a CI runner starts from an empty state
 * and proposes to create the estate again.
 *
 * One diagnostic per root, fired from the root's `terraform` block. A root
 * with no `terraform` block at all is not flagged: it declares no version
 * constraints either, and the missing block is a different finding.
 *
 * Does not fire on a live root (#2103): a `backend` block is exactly what
 * choudoufu refuses there (TF024's territory), and the fallback to local
 * state this check warns about does not apply, since a live root keeps no
 * state file at all, local or remote.
 */

import type {
  PostSynthCheck,
  PostSynthContext,
  PostSynthDiagnostic,
} from "@intentius/chant/lint/post-synth";
import { isResourceDeclarable } from "@intentius/chant/declarable";
import { TERRAFORM_TYPE, type BlockBody } from "../../hcl/parse";

/** `backend`/`cloud` are blocks, so hcl2json encodes them as a value under the key. */
export function hasBlock(body: BlockBody, key: string): boolean {
  const value = body[key];
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === "object" ? Object.keys(value as object).length > 0 : true;
}

export const tf001: PostSynthCheck = {
  id: "TF001",
  description: "Root module declares no remote backend",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    /** Root name to the entity key of the first `terraform` block seen for it. */
    const flagged = new Set<string>();

    for (const [name, entity] of ctx.entities) {
      if (entity.entityType !== TERRAFORM_TYPE) continue;
      if (!isResourceDeclarable(entity)) continue;
      const props = entity.props as { root?: unknown; body?: unknown; mode?: unknown };
      if (props.mode === "live") continue;
      const root = typeof props.root === "string" ? props.root : "";
      if (flagged.has(root)) continue;

      const body = (typeof props.body === "object" && props.body !== null ? props.body : {}) as BlockBody;
      if (hasBlock(body, "backend") || hasBlock(body, "cloud")) continue;

      flagged.add(root);
      diagnostics.push({
        checkId: "TF001",
        severity: "warning",
        message:
          `Root module "${root}" declares no remote backend. State falls back to a local ` +
          "terraform.tfstate, which is unshared, unlocked and holds every resource attribute in " +
          'plaintext. Add a `backend "<type>"` or a `cloud {}` block to the terraform block.',
        entity: name,
        lexicon: "terraform",
      });
    }

    return diagnostics;
  },
};
