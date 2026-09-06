/**
 * TF025: a live root reads a non-default `terraform.workspace`, or configures
 * one through `terraform.roots`.
 *
 * choudoufu refuses any workspace but `default` on a live root, and refuses
 * `workspace new`/`workspace select` outright: only the default workspace
 * exists there ("How you run it" in choudoufu's compatibility reference).
 * Two independent ways a configuration ends up asking for one:
 *
 *   - `terraform.roots.<name>.workspace` in `chant.config.*` selects a
 *     workspace via `TF_WORKSPACE` before any HCL is even read, chant's own
 *     equivalent of `workspace select`, so it is flagged the same way.
 *   - A `"${terraform.workspace}"` interpolation anywhere in a block's body
 *     reads the (necessarily `"default"`) workspace name in configuration,
 *     which is not itself refused by choudoufu but is dead code on a live
 *     root and a sign the configuration was written for a workspace-per-
 *     environment layout that live mode does not support.
 *
 * The first fires once per root (it names a root-level config field, not a
 * particular block); the second fires once per block that contains the
 * reference, since each is its own thing to fix.
 */

import type {
  PostSynthCheck,
  PostSynthContext,
  PostSynthDiagnostic,
} from "@intentius/chant/lint/post-synth";
import { isResourceDeclarable } from "@intentius/chant/declarable";

/** Recursively search a parsed HCL body for a `terraform.workspace` reference, un-evaluated interpolations included. */
function containsWorkspaceRef(value: unknown): boolean {
  if (typeof value === "string") return /\bterraform\.workspace\b/.test(value);
  if (Array.isArray(value)) return value.some(containsWorkspaceRef);
  if (value !== null && typeof value === "object") return Object.values(value).some(containsWorkspaceRef);
  return false;
}

export const tf025: PostSynthCheck = {
  id: "TF025",
  description: "Live root references a non-default terraform.workspace, which choudoufu refuses",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    const flaggedRootWorkspace = new Set<string>();

    for (const [name, entity] of ctx.entities) {
      if (!isResourceDeclarable(entity)) continue;
      const props = entity.props as {
        root?: unknown;
        body?: unknown;
        mode?: unknown;
        workspace?: unknown;
        address?: unknown;
      };
      if (props.mode !== "live") continue;
      const root = typeof props.root === "string" ? props.root : "";

      if (
        typeof props.workspace === "string" &&
        props.workspace !== "" &&
        props.workspace !== "default" &&
        !flaggedRootWorkspace.has(root)
      ) {
        flaggedRootWorkspace.add(root);
        diagnostics.push({
          checkId: "TF025",
          severity: "error",
          message:
            `Root module "${root}" runs choudoufu with a declared estate and configures workspace ` +
            `"${props.workspace}" in terraform.roots.${root}. choudoufu refuses any workspace but ` +
            '"default" on a live root. Remove `workspace` from this root\'s config (or set it to "default").',
          entity: name,
          lexicon: "terraform",
        });
      }

      if (containsWorkspaceRef(props.body)) {
        const address = typeof props.address === "string" ? props.address : name;
        diagnostics.push({
          checkId: "TF025",
          severity: "error",
          message:
            `"${address}" in root module "${root}" references \`terraform.workspace\`. choudoufu refuses ` +
            'any workspace but "default" on a live root, so this always resolves to "default" there. ' +
            "Remove the reference.",
          entity: name,
          lexicon: "terraform",
        });
      }
    }

    return diagnostics;
  },
};
