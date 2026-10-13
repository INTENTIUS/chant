/**
 * Shared reading for the Terragrunt rules TF041 to TF045 (#3417).
 *
 * These rules look at `terragrunt.hcl` and `root.hcl`, which the parse reads
 * into their own entity types (`TERRAGRUNT_*_TYPE` in `../../hcl/parse.ts`)
 * and never into the module types the other TF rules check. Like the module
 * source rules, they read the literal values hcl2json hands back: an
 * attribute built from a function or a `local.` reference arrives as a
 * `"${...}"` string and is treated as not determined, never as a finding.
 */

import { isResourceDeclarable, type Declarable } from "@intentius/chant/declarable";
import type { BlockBody } from "../../hcl/parse";
import { classifyModuleSource } from "./module-source";

/** Entities of one Terragrunt type, with their keys, in map order. */
export function terragruntEntities(
  entities: ReadonlyMap<string, Declarable>,
  entityType: string,
): Array<{ key: string; address: string; file: string; body: BlockBody }> {
  const out: Array<{ key: string; address: string; file: string; body: BlockBody }> = [];
  for (const [key, entity] of entities) {
    if (entity.entityType !== entityType || !isResourceDeclarable(entity)) continue;
    const props = entity.props as { address?: unknown; file?: unknown; body?: unknown };
    out.push({
      key,
      address: typeof props.address === "string" ? props.address : key,
      file: typeof props.file === "string" ? props.file : "terragrunt.hcl",
      body: (typeof props.body === "object" && props.body !== null ? props.body : {}) as BlockBody,
    });
  }
  return out;
}

/** An HCL expression hcl2json left as `"${...}"`: its value is not known without evaluating it. */
export function isExpression(value: unknown): boolean {
  return typeof value === "string" && value.includes("${");
}

export type TerragruntSourceKind = "local" | "git" | "tfr" | "oci" | "other";

export interface TerragruntSourceClassification {
  kind: TerragruntSourceKind;
  /** Whether the source names a version: `?ref=` for git, `?version=` for `tfr://`, a tag or digest for `oci://`. Undefined for `local` and `other`. */
  pinned?: boolean;
}

/**
 * Classify a unit's `terraform.source`. Git and `oci://` sources go through
 * {@link classifyModuleSource}, the reader TF005 and TF038 use. `tfr://` is
 * Terragrunt's own scheme for registry modules and takes its version from the
 * `?version=` query argument. A source that holds an interpolation, or that
 * names an absolute path or an archive URL, is `other` or `local` and is
 * never reported.
 */
export function classifyTerragruntSource(source: string): TerragruntSourceClassification {
  const trimmed = source.trim();
  if (trimmed.includes("${")) return { kind: "other" };
  if (/^tfr:\/\//i.test(trimmed)) {
    const query = trimmed.includes("?") ? trimmed.slice(trimmed.indexOf("?") + 1) : "";
    const version = new URLSearchParams(query).get("version");
    return { kind: "tfr", pinned: version !== null && version.trim() !== "" };
  }
  if (trimmed.startsWith("/")) return { kind: "local" };
  const classified = classifyModuleSource(trimmed);
  switch (classified.kind) {
    case "local":
      return { kind: "local" };
    case "git":
      return { kind: "git", pinned: classified.ref !== undefined };
    case "oci":
      return { kind: "oci", pinned: classified.tag !== undefined || classified.digest !== undefined };
    default:
      return { kind: "other" };
  }
}
