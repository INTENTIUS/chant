/**
 * The record store a live root resolves to, read from its HCL the way
 * choudoufu resolves it (INTENTIUS/choudoufu#2293, `internal/configs/live_derive.go`
 * at choudoufu 74ffde956bfd97f44b8ad444424584e23321adc2). Shared by TF024,
 * which names where records go, and TF046, which guards a CI root that ends
 * up on the local store, so the two never disagree.
 *
 * The order is choudoufu's:
 *
 * 1. A `record_store "<kind>"` block in the `live` block or the
 *    `estate.chdf.hcl` sidecar always wins (`source: "record_store"`).
 * 2. Otherwise the backend block choudoufu ignores under live gives the store,
 *    s3 to s3, gcs to gcs, azurerm to azurerm (`source: "backend"`). s3 and gcs
 *    need a literal `bucket`; azurerm needs literal `storage_account_name`,
 *    `container_name` and `resource_group_name`. A value passed only with
 *    `-backend-config` is not in the configuration, so choudoufu does not see
 *    it either.
 * 3. Otherwise the store is local (`source: "implied"`), with `note` saying
 *    why a backend that was there was not used.
 *
 * This mirrors `record_store.source` and `record_store.note` in
 * `choudoufu live-check -json`. A literal here is a string hcl2json hands back
 * with no `${...}` in it, the same "not determined" reading the Terragrunt
 * rules use (`./terragrunt.ts`).
 */

import type { BlockBody } from "../../hcl/parse";
import { backendTypes } from "./tf001";
import { isExpression } from "./terragrunt";

export type RecordStoreSource = "record_store" | "backend" | "implied";

export interface ResolvedRecordStore {
  /** `local`, `s3`, `gcs`, `azurerm` or `kubernetes`, or whatever label a `record_store` block carries. */
  kind: string;
  source: RecordStoreSource;
  /** The backend type the store came from, or was not derived from, when there is a backend block. */
  backend?: string;
  /** Why a backend block that was present did not give a store. Set only with `source: "implied"`. */
  note?: string;
}

/** Backend types choudoufu derives a record store from (INTENTIUS/choudoufu#2293). */
export const DERIVABLE_BACKENDS: ReadonlySet<string> = new Set(["s3", "gcs", "azurerm"]);

const asRecord = (v: unknown): BlockBody =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as BlockBody) : {};

const firstBody = (v: unknown): BlockBody => asRecord(Array.isArray(v) ? v[0] : v);

/**
 * The label of a `record_store "<kind>"` block in a live declaration body, or
 * undefined when it declares none. hcl2json nests the label one level down,
 * as it does for `backend` (see `backendTypes` in `./tf001.ts`).
 */
export function recordStoreKind(liveBody: BlockBody): string | undefined {
  const raw = liveBody["record_store"];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const labels = Object.keys(raw as BlockBody);
  return labels[0];
}

/** A top-level backend argument as a literal string, or undefined when it is absent, empty or an expression. */
function literal(body: BlockBody, name: string): string | undefined {
  const v = body[name];
  if (typeof v !== "string" || v === "" || isExpression(v)) return undefined;
  return v;
}

/**
 * Why a backend block gives no record store, or undefined when it gives one.
 * The wording follows choudoufu's `Live.RecordStoreNote`; an empty string
 * means no store and nothing to say (a `local` backend).
 */
function derivationNote(type: string, body: BlockBody): string | undefined {
  const where = `backend "${type}"`;
  switch (type) {
    case "s3":
    case "gcs":
      return literal(body, "bucket") === undefined
        ? `${where} sets no literal bucket; values passed with -backend-config are not read`
        : undefined;
    case "azurerm":
      for (const name of ["storage_account_name", "container_name", "resource_group_name"]) {
        if (literal(body, name) === undefined) return `${where} sets no literal ${name}, which the azurerm record store needs`;
      }
      return undefined;
    case "local":
      // choudoufu leaves no note here: a local backend and the local store agree.
      return "";
    default:
      return `${where} has no record store counterpart`;
  }
}

/**
 * Resolve one live root's record store.
 *
 * `terraformBodies` are the bodies of every `terraform` block in the root (a
 * backend can sit in a separate `backend.tf`). `liveBodies` are the root's
 * live declarations: its `live` block and its sidecar, if any. choudoufu
 * refuses a root that has both, so the first `record_store` found is the one.
 */
export function resolveRecordStore(
  terraformBodies: readonly BlockBody[],
  liveBodies: readonly BlockBody[],
): ResolvedRecordStore {
  for (const live of liveBodies) {
    const kind = recordStoreKind(live);
    if (kind !== undefined) return { kind, source: "record_store" };
  }
  for (const tf of terraformBodies) {
    const type = backendTypes(tf)[0];
    if (type === undefined) continue;
    const body = firstBody(asRecord(tf["backend"])[type]);
    const note = derivationNote(type, body);
    if (note === undefined) return { kind: type, source: "backend", backend: type };
    return { kind: "local", source: "implied", backend: type, ...(note ? { note } : {}) };
  }
  return { kind: "local", source: "implied" };
}
