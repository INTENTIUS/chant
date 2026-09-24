/**
 * The record kinds a declaration names, loaded (#2680).
 *
 * `chant.workspace.json` may name the workspace's record kinds, in the
 * top-level `records` and in each member's `records`, so a reader never has to
 * guess which kind files exist. `chant workspace ls` lists them, `check` fails
 * on one that doesn't load (WSP115), and `records` and `graph --intent` read
 * every one of them when `--kind` is not given.
 *
 * A kind file is looked for in the tree read, which is the revision under
 * `--at`, and loaded from the working tree, as `records --kind` loads one.
 * Loading imports the file, so it runs only where a command already runs a
 * kind file.
 */

import { join } from "node:path";
import { declaredRecordKinds, type Declaration, type RecordKindDeclaration } from "./declaration";
import type { ReasonCode } from "./reason-codes";
import type { WorkspaceTree } from "./tree";

/** Why a declared kind can't be loaded: the codes `loadRecordKind` fails with. Closed, like every list of codes. */
export const DECLARED_KIND_REASON_CODES = ["kind-unreadable", "kind-invalid", "schema-unreadable", "schema-id-mismatch"] as const satisfies readonly ReasonCode[];
export type DeclaredKindReasonCode = (typeof DECLARED_KIND_REASON_CODES)[number];

export interface DeclaredKind {
  declared: RecordKindDeclaration;
  /** The kind file on disk, absolute. */
  file: string;
  /** The kind file's `recordKind.name`, or null when it wasn't loaded. */
  kind: string | null;
  /** Why it can't be loaded, or null. */
  reason: { code: DeclaredKindReasonCode; message: string } | null;
}

/** The kind file of `declared` on disk, under the workspace root `rootOnDisk`. */
export function declaredKindFile(declared: RecordKindDeclaration, rootOnDisk: string): string {
  return join(rootOnDisk, ...declared.path.split("/"));
}

/**
 * Every kind the declaration names, in {@link declaredRecordKinds} order, each
 * with its name or the reason it can't be loaded. A kind file missing from
 * `tree` is `kind-unreadable` without a load. With `load: false`, nothing is
 * imported and only that is checked.
 */
export async function loadDeclaredKinds(
  declaration: Declaration,
  tree: WorkspaceTree,
  rootOnDisk: string,
  options: { load?: boolean } = {},
): Promise<DeclaredKind[]> {
  const declared = declaredRecordKinds(declaration);
  if (declared.length === 0) return [];
  const records = options.load === false ? undefined : await import("./records");
  const out: DeclaredKind[] = [];
  for (const d of declared) {
    const file = declaredKindFile(d, rootOnDisk);
    if (tree.stat(d.path) !== "file") {
      out.push({ declared: d, file, kind: null, reason: { code: "kind-unreadable", message: `kind file ${d.path} does not exist${tree.label}` } });
      continue;
    }
    if (!records) {
      out.push({ declared: d, file, kind: null, reason: null });
      continue;
    }
    try {
      const loaded = await records.loadRecordKind(file);
      out.push({ declared: d, file, kind: loaded.kind.name, reason: null });
    } catch (err) {
      if (!(err instanceof records.RecordReadError)) throw err;
      // loadRecordKind names the file as it was given, here an absolute path: name it from the workspace root instead.
      out.push({ declared: d, file, kind: null, reason: { code: err.code as DeclaredKindReasonCode, message: err.message.split(file).join(d.path) } });
    }
  }
  return out;
}
