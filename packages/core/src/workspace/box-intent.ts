/**
 * A box's intent (#2850): the decision record its box block names.
 *
 * A new box starts as a question, and the first answer to it is what the box
 * is for. That answer is a decision record, so the intent graph, hud and a
 * box's runtime all read the same thing. The box block names the record's
 * id in `intent`; the record is looked for among the records of every
 * declared kind named `decision` (the entry's `name`, or the kind file's
 * `recordKind.name`), read from the working tree through the same reader as
 * `chant workspace records`.
 *
 * `chant workspace status --json` reports the record's state and answer
 * under the member's `box.intent`, and `chant workspace check` fails when no
 * decision record has the id (WSP126) and warns when the record constrains
 * nothing of the box (WSP127).
 */

import { loadDeclaredKinds, type DeclaredKind } from "./declared-kinds";
import type { Declaration, Member } from "./declaration";
import { constraintCovers, isWorkspacePath } from "./record-assets";
import { workingTree } from "./tree";

/** The declared kind name a box's intent is looked for in. */
export const INTENT_KIND_NAME = "decision";

/** A box's intent as `status --json` reports it: the record's id, state and answer. */
export interface BoxIntent {
  id: string;
  /** The record's state, such as proposed or decided, or null when no decision record has the id. */
  state: string | null;
  question: string | null;
  /** The record's choice as written, such as `{ option, reason }`, or null while it is proposed. */
  choice: unknown;
  decided_by: string | null;
  decided_on: string | null;
}

/** The decision record a box's intent names, as the checks read it. */
export interface ResolvedBoxIntent {
  member: string;
  id: string;
  /** The `intent` field's JSON Pointer in the declaration. */
  pointer: string;
  /** The record, or null when no decision record has the id. */
  record: {
    /** The kind file that holds it, from the workspace root. */
    kind: string;
    /** The record file, from the repository root. */
    path: string;
    /** The record's constrains entries, as written. */
    constrains: string[];
    intent: BoxIntent;
  } | null;
  /** Why no record was found when none was, such as no declared decision kind. Empty when one was found. */
  why: string;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** The intent of `id` with no record: every field but the id null. */
export function unresolvedIntent(id: string): BoxIntent {
  return { id, state: null, question: null, choice: null, decided_by: null, decided_on: null };
}

/**
 * Resolve the intent of every box that names one, reading the records of each
 * declared decision kind once. `kinds` are the declared kinds already loaded,
 * when the caller has them. Only the working tree is read.
 */
export async function resolveBoxIntents(declaration: Declaration, root: string, kinds?: readonly DeclaredKind[]): Promise<ResolvedBoxIntent[]> {
  const boxes = declaration.members.filter((m): m is Member & { box: NonNullable<Member["box"]> & { intent: string } } => m.box?.intent != null);
  if (boxes.length === 0) return [];
  const loaded = kinds ?? (await loadDeclaredKinds(declaration, workingTree(root), root));
  const decisionKinds = loaded.filter((k) => (k.declared.name ?? k.kind) === INTENT_KIND_NAME);
  const found = new Map<string, NonNullable<ResolvedBoxIntent["record"]>>();
  const problems: string[] = [];
  const { readRecordsFor } = await import("./records-cli");
  const { RecordReadError } = await import("./records");
  for (const k of decisionKinds) {
    if (k.reason) {
      problems.push(`${k.declared.path} can't be loaded: ${k.reason.message}`);
      continue;
    }
    try {
      const read = await readRecordsFor({ kind: k.file, cwd: root, workGaps: false });
      const field = read.loaded.kind.constrains?.field ?? "constrains";
      for (const r of read.result.records) {
        if (r.id === null || found.has(r.id)) continue;
        const data = r.data ?? {};
        const constrains = Array.isArray(data[field]) ? (data[field] as unknown[]).filter((c): c is string => typeof c === "string") : [];
        found.set(r.id, {
          kind: k.declared.path,
          path: r.path,
          constrains,
          intent: {
            id: r.id,
            state: r.state,
            question: str(data.question),
            choice: data.choice ?? null,
            decided_by: str(data.decided_by),
            decided_on: str(data.decided_on),
          },
        });
      }
    } catch (err) {
      if (!(err instanceof RecordReadError)) throw err;
      problems.push(`${k.declared.path} can't be read: ${err.message}`);
    }
  }
  const why =
    decisionKinds.length === 0
      ? `the declaration names no record kind called ${INTENT_KIND_NAME}`
      : `no record of ${decisionKinds.map((k) => k.declared.path).join(" or ")} has that id` + (problems.length > 0 ? ` (${problems.join("; ")})` : "");
  return boxes.map((m) => {
    const record = found.get(m.box.intent) ?? null;
    return { member: m.name, id: m.box.intent, pointer: `${m.box.pointer}/intent`, record, why: record ? "" : why };
  });
}

/**
 * Whether a constrains entry covers something of the box: `member:<name>`, or
 * a `path:` entry that is the member's directory, a directory above it or a
 * path inside it.
 */
export function constrainsBox(entry: string, member: { name: string; dir: string }): boolean {
  if (entry === `member:${member.name}`) return true;
  if (!entry.startsWith("path:")) return false;
  const path = entry.slice("path:".length);
  if (!isWorkspacePath(path)) return false;
  // The root member holds every path.
  if (member.dir === ".") return true;
  return constraintCovers(path, member.dir) || constraintCovers(member.dir, path);
}
