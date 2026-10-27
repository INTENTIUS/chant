/**
 * TF024: a live root declares a `backend` or `cloud` block.
 *
 * choudoufu used to refuse this pair at `init` (#1170). Since
 * INTENTIUS/choudoufu#2213 it accepts both and ignores them with a warning
 * (`internal/configs/module.go`, `ignoreStateStoreUnderLive`), because
 * Terragrunt's `remote_state` and Atmos's `backend.tf.json` write a backend
 * beside the live block on every run. What each block still does:
 *
 * - `backend "<type>"`: no state is read or written there, and
 *   `init -migrate-state` is refused. choudoufu keeps the block as
 *   `IgnoredBackend`: an apply publishes the estate's non-sensitive outputs
 *   to the location it names, so `terraform_remote_state` readers keep
 *   working, and when the live declaration has no `record_store` the record
 *   store is derived from the backend's bucket, s3 to s3, gcs to gcs, azurerm
 *   to azurerm (INTENTIUS/choudoufu#2293), when the bucket is a literal in
 *   the configuration. An explicit `record_store` always wins. The resolution
 *   is shared with TF046 in `./record-store.ts`.
 * - `cloud {}`: dropped entirely. Nothing is published to it and no store is
 *   derived from it.
 *
 * So the backend case is reported as `info` (the block is doing a job the
 * author may want, and is the derivation source the maintainer ruled for),
 * and the cloud case as `warning` (the block does nothing at all). Neither
 * fails a build at default severity. The guard against a CI root that ends
 * up on the local store is TF046 (chant#4561).
 *
 * The live marker is the root's `mode`, stamped from either a `live` block or
 * an `estate.chdf.hcl` sidecar (`hcl/parse.ts`), so a sidecar estate is
 * covered. A `record_store` is read from whichever `Terraform::Live` entity
 * carries it: the `live` block, or the sidecar's top level.
 *
 * TF001 is the equivalent check for a stock root (no remote backend is
 * configured); it does not fire on a live root. A root is flagged by at most
 * one of them.
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
import { LIVE_TYPE, TERRAFORM_TYPE, type BlockBody } from "../../hcl/parse";
import { backendTypes, hasBlock } from "./tf001";
import { isRootScoped } from "./scope";
import { DERIVABLE_BACKENDS, resolveRecordStore, type ResolvedRecordStore } from "./record-store";

export { DERIVABLE_BACKENDS } from "./record-store";

const bodyOf = (props: { body?: unknown }): BlockBody =>
  (typeof props.body === "object" && props.body !== null ? props.body : {}) as BlockBody;

/** Each root's live declarations (its `live` block and its sidecar), keyed by root. */
export function liveBodiesByRoot(ctx: PostSynthContext): Map<string, BlockBody[]> {
  const roots = new Map<string, BlockBody[]>();
  for (const entity of ctx.entities.values()) {
    if (entity.entityType !== LIVE_TYPE) continue;
    if (!isResourceDeclarable(entity) || !isRootScoped(entity)) continue;
    const props = entity.props as { root?: unknown; body?: unknown };
    const root = typeof props.root === "string" ? props.root : "";
    const list = roots.get(root) ?? [];
    list.push(bodyOf(props));
    roots.set(root, list);
  }
  return roots;
}

function backendMessage(root: string, type: string, store: ResolvedRecordStore): string {
  const label = type ? `backend "${type}"` : "backend";
  const head =
    `Root module "${root}" runs choudoufu with a declared estate and also declares a ${label} block. ` +
    "choudoufu ignores it with a warning: no state is read or written there and `init -migrate-state` " +
    "is refused. An apply publishes the estate's non-sensitive outputs to the location it names, so " +
    "terraform_remote_state readers keep working.";
  if (store.source === "record_store") {
    return `${head} Records go to the record_store the live declaration names, which wins over the backend.`;
  }
  if (store.source === "backend") {
    return (
      `${head} With no record_store declared, choudoufu derives the record store from this backend's ` +
      "bucket and prints it on every init and plan (INTENTIUS/choudoufu#2293). Declare record_store to " +
      "put records somewhere else."
    );
  }
  const why = DERIVABLE_BACKENDS.has(type) && store.note
    ? `No record store is derived from it: ${store.note}.`
    : `No record store is derived from a ${type ? `"${type}"` : "backend of unknown type"} (only s3, gcs and azurerm are).`;
  return (
    `${head} ${why} No record_store is declared, so records stay in the local ` +
    "store. Declare record_store if more than one machine runs this root (TF046 guards this in CI)."
  );
}

function cloudMessage(root: string): string {
  return (
    `Root module "${root}" runs choudoufu with a declared estate and also declares a cloud block. ` +
    "choudoufu ignores it entirely: no state is read or written there, no outputs are published to it, " +
    "and no record store is derived from it. Remove it, or use a backend block if " +
    "terraform_remote_state readers need this estate's outputs."
  );
}

export const tf024: PostSynthCheck = {
  id: "TF024",
  description: "Live root declares a backend or cloud block, which choudoufu ignores",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    const flagged = new Set<string>();
    let liveBodies: Map<string, BlockBody[]> | undefined;

    for (const [name, entity] of ctx.entities) {
      if (entity.entityType !== TERRAFORM_TYPE) continue;
      if (!isResourceDeclarable(entity) || !isRootScoped(entity)) continue;
      const props = entity.props as { root?: unknown; body?: unknown; mode?: unknown };
      if (props.mode !== "live") continue;
      const root = typeof props.root === "string" ? props.root : "";
      if (flagged.has(root)) continue;

      const body = bodyOf(props);
      const hasCloud = hasBlock(body, "cloud");
      const hasBackend = hasBlock(body, "backend");
      if (!hasBackend && !hasCloud) continue;
      flagged.add(root);

      // A cloud block does nothing at all, so it is the one worth a warning
      // when a (malformed) root somehow carries both.
      if (hasCloud) {
        diagnostics.push({ checkId: "TF024", severity: "warning", message: cloudMessage(root), entity: name, lexicon: "terraform" });
        continue;
      }

      liveBodies ??= liveBodiesByRoot(ctx);
      const type = backendTypes(body)[0] ?? "";
      const store = resolveRecordStore([body], liveBodies.get(root) ?? []);
      diagnostics.push({
        checkId: "TF024",
        severity: "info",
        message: backendMessage(root, type, store),
        entity: name,
        lexicon: "terraform",
      });
    }

    return diagnostics;
  },
};
