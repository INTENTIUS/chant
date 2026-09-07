/**
 * TF001: a root module keeps its state on local disk.
 *
 * Two ways a root gets there, and this reports both (#2218). A `terraform`
 * block with no `backend "<type>"` and no `cloud {}` falls back to the local
 * backend implicitly. A `backend "local"` block asks for the same backend by
 * name. Either way `terraform.tfstate` lands in the working directory, and
 * that file holds every attribute of every managed resource, secrets
 * included, and it is not shared, not locked, and not versioned. The first
 * apply from a second machine or a CI runner starts from an empty state and
 * proposes to create the estate again.
 *
 * So the rule reads the backend block's TYPE LABEL rather than its presence:
 * the id means "no remote backend", which is what its name, its message and
 * its page have always argued. `cloud {}` counts as remote (it is Terraform
 * Cloud / HCP state, held off the machine and locked). Every other backend
 * type is taken as remote without a list to maintain, since `local` is the
 * only backend Terraform ships that writes to the working directory.
 *
 * A root that keeps local state on purpose says so with a
 * `# chant-ignore-block: TF001` on the line above its `terraform` block
 * (chant #2111), which is what the three shipped examples do.
 *
 * One diagnostic per root, fired from the root's `terraform` block. A root
 * with no `terraform` block at all is not flagged: it declares no version
 * constraints either, and the missing block is a different finding.
 *
 * Scope: root modules only (#2112). A child module must NOT declare a
 * backend, which is the mirror image and TF015's finding, so a descended
 * module's `terraform` block is skipped here rather than read as if it were
 * the root's.
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
import { attr } from "../../hcl/value";
import { isRootScoped } from "./scope";

/**
 * `backend`/`cloud` are blocks, so hcl2json encodes them as a value under the
 * key, structurally the same "literal value under this key" shape `attr()`
 * (`../../hcl/value.ts`, chant #2113) reads for an ordinary attribute, so
 * this reads through it rather than re-deriving presence by hand.
 */
export function hasBlock(body: BlockBody, key: string): boolean {
  const a = attr(body, key);
  if (a.kind === "absent") return false;
  if (Array.isArray(a.value)) return a.value.length > 0;
  return typeof a.value === "object" && a.value !== null ? Object.keys(a.value).length > 0 : true;
}

/** The one backend type that writes state to the working directory. */
export const LOCAL_BACKEND = "local";

/**
 * The type labels of the `backend` blocks in a `terraform` block body.
 *
 * `backend` takes one label, so hcl2json nests it one level deeper than an
 * unlabelled block: `backend "s3" { bucket = "b" }` is
 * `{ backend: { s3: [{ bucket: "b" }] } }`, where `cloud { ... }` is just
 * `{ cloud: [{ ... }] }`. The keys of that inner object are the labels, which
 * is the only place the type survives the parse. A malformed body that puts
 * an array or a scalar under `backend` yields no labels, and the caller then
 * treats the root as having no remote backend, the same verdict a missing
 * block gets.
 */
export function backendTypes(body: BlockBody): string[] {
  const a = attr(body, "backend");
  if (a.kind === "absent") return [];
  const value = a.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  return Object.keys(value);
}

/**
 * Whether the body configures state somewhere other than the working
 * directory: any `backend` block whose type is not `local`, or a `cloud`
 * block.
 */
export function hasRemoteBackend(body: BlockBody): boolean {
  if (hasBlock(body, "cloud")) return true;
  return backendTypes(body).some((type) => type !== LOCAL_BACKEND);
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
      if (!isResourceDeclarable(entity) || !isRootScoped(entity)) continue;
      const props = entity.props as { root?: unknown; body?: unknown; mode?: unknown };
      if (props.mode === "live") continue;
      const root = typeof props.root === "string" ? props.root : "";
      if (flagged.has(root)) continue;

      const body = (typeof props.body === "object" && props.body !== null ? props.body : {}) as BlockBody;
      if (hasRemoteBackend(body)) continue;

      // What the root actually declares, so the message names it rather than
      // saying "no remote backend" over a block the reader can see.
      const found = backendTypes(body).includes(LOCAL_BACKEND)
        ? 'the backend it declares is `backend "local"`'
        : "there is no backend block at all";

      flagged.add(root);
      diagnostics.push({
        checkId: "TF001",
        severity: "warning",
        message:
          `Root module "${root}" declares no remote backend: ${found}. State is a ` +
          "terraform.tfstate in the working directory, which is unshared, unlocked and holds every " +
          'resource attribute in plaintext. Declare a `backend "<type>"` naming a remote type (`s3`, ' +
          "`gcs`, `azurerm`, `http`) or a `cloud {}` block, or keep the local state on purpose with a " +
          "`# chant-ignore-block: TF001` above the terraform block.",
        entity: name,
        lexicon: "terraform",
        // The missing-resource shape (chant #2113): there is no remote
        // `backend`/`cloud` block to point at, only the root that lacks one.
        // `entity` above still names the `terraform` block this fired from (by
        // convenience, not because that block is what's wrong), so `missing`
        // is what a suppression should key on instead. `kind` stays `backend`
        // in both cases: what is absent is a remote backend, whether or not a
        // `backend "local"` block is sitting where one should be.
        missing: { kind: "backend", scope: root },
      });
    }

    return diagnostics;
  },
};
