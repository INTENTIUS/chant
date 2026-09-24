/**
 * Which files are generated, and by what (#2524 D14, #2541).
 *
 * One list answers the question for everyone who asks it: the drift check in
 * `checks/generated.ts` and the lineage lock's `generated` class
 * (`lineage-lock.ts`). The list is the member's declared `generated` entries
 * plus the files core registers itself:
 *
 * | File                  | Class     |
 * |-----------------------|-----------|
 * | `skills/*\/SKILL.md`  | generated, by `chant update` |
 * | `.mcp.json`           | seed      |
 * | `.chant/types/`       | ignored: gitignored, never listed |
 *
 * A declared entry wins over the implicit rules, so a member can list a
 * `SKILL.md` it keeps by hand. A hand-written entry is the project's own
 * file, so the lock classes it `owned`.
 *
 * Everything here loads only with the lineage and workspace commands.
 */

import { relative, resolve, sep } from "node:path";
import { findWorkspaceRoot } from "../project-root";
import { isInside, readDeclaration, type Declaration } from "./declaration";
import { workingTree } from "./tree";

/** What `chant update` rewrites, registered as implicit generated entries. */
export const IMPLICIT_GENERATED = [{ glob: "skills/*/SKILL.md", pattern: /^skills\/[^/]+\/SKILL\.md$/, command: "chant update" }] as const;

/** Written once at init and never again. */
export const SEED_FILES = [".mcp.json"] as const;

/** Gitignored output, out of scope for both the lock and the drift check. */
export const IGNORED_DIRS = [".chant/types"] as const;

/** A declared entry, keyed by its path relative to the directory asked about. */
export interface DeclaredFile {
  command: string;
  handWritten: boolean;
}
export type DeclaredFiles = ReadonlyMap<string, DeclaredFile>;

export type FileClassification =
  | { class: "owned" }
  | { class: "generated"; command: string }
  | { class: "seed" }
  | { class: "ignored" };

/** The implicit entry `path` matches, if any. */
export function implicitGenerated(path: string): (typeof IMPLICIT_GENERATED)[number] | undefined {
  return IMPLICIT_GENERATED.find((i) => i.pattern.test(path));
}

/** Class a file by the declared entries first, then by the implicit rules (D14). */
export function classifyFile(path: string, declared?: DeclaredFiles): FileClassification {
  const entry = declared?.get(path);
  if (entry) return entry.handWritten ? { class: "owned" } : { class: "generated", command: entry.command };
  if (IGNORED_DIRS.some((d) => path === d || path.startsWith(`${d}/`))) return { class: "ignored" };
  const implicit = implicitGenerated(path);
  if (implicit) return { class: "generated", command: implicit.command };
  if ((SEED_FILES as readonly string[]).includes(path)) return { class: "seed" };
  return { class: "owned" };
}

/**
 * Every declared generated file of `declaration` that sits under `dir`
 * (relative to the workspace root, `"."` for all of it), keyed by its path
 * relative to `dir`.
 */
export function declaredFilesUnder(declaration: Declaration, dir: string): Map<string, DeclaredFile> {
  const out = new Map<string, DeclaredFile>();
  for (const m of declaration.members) {
    for (const g of m.generated) {
      const full = m.dir === "." ? g.path : `${m.dir}/${g.path}`;
      if (!isInside(full, dir)) continue;
      out.set(dir === "." ? full : full.slice(dir.length + 1), { command: g.generator, handWritten: g.handWritten !== null });
    }
  }
  return out;
}

/**
 * The declared generated files for the absolute directory `absDir`, from the
 * nearest `chant.workspace.json` above it. Empty when there is none, which is
 * the plain-project case: only the implicit rules apply. A declaration that
 * can't be read throws its `WorkspaceReadError`; it is never read as empty.
 */
export function declaredFilesFor(absDir: string): Map<string, DeclaredFile> {
  const found = findWorkspaceRoot(absDir);
  if (!found) return new Map();
  const declaration = readDeclaration(workingTree(found.dir));
  const rel = relative(found.dir, resolve(absDir)).split(sep).join("/");
  return declaredFilesUnder(declaration, rel === "" ? "." : rel);
}
