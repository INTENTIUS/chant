/**
 * The decisions covering each member, for the gates in `chant workspace
 * status --json` (#3616): a reader showing a gate to the person about to
 * approve it names the decision the gate enforces without a
 * `graph --intent` walk of its own.
 *
 * This is the part of the intent walk (`intent.ts`) that reads only records.
 * A decision covers a member when one of its `constrains` entries is
 * `member:<name>`, or a `path:` that is the member's directory, a directory
 * above it, or a path inside it that the member holds (not a member nested
 * in it). A superseded covering decision stands for the decision that
 * supersedes it, at the end of its chain. Only current decisions are listed,
 * as `<kind>/<id>`, ranked as `why.decisions` ranks them
 * (`decision-rank.ts`). `carried` needs the member's history, so it never
 * applies, and neither do `issue` or `contract`, which need commits. Every
 * declared record kind other than a work kind is read, as the intent walk
 * reads them; a kind that can't be read is left out.
 */

import { declaredRecordKinds, type Declaration } from "./declaration";
import { declaredKindFile } from "./declared-kinds";
import { compareDecisionRank, type DecisionRankKey, type WhyRelevance } from "./decision-rank";
import { decidedCommits } from "./record-decided";
import { constraintCovers, isWorkspacePath, memberHolding } from "./record-assets";
import type { LoadedRecordKind, RecordEntry } from "./records";
import { joinPath } from "./tree";

interface ReadKind {
  loaded: LoadedRecordKind;
  top: string | undefined;
  /** Where the kind's `path:` entries resolve, from the git top. */
  prefix: string;
  records: RecordEntry[];
  byId: Map<string, RecordEntry>;
}

/** Reads one kind's records, current and superseded; `readRecordsFor` in the working tree unless a test swaps it. */
export type DecisionKindReader = (file: string, root: string) => Promise<{ loaded: LoadedRecordKind; top: string | undefined; workspaceRoot: string; records: RecordEntry[] }>;

const defaultReader: DecisionKindReader = async (file, root) => {
  const { readRecordsFor } = await import("./records-cli");
  const read = await readRecordsFor({ kind: file, cwd: root });
  return { loaded: read.loaded, top: read.top, workspaceRoot: read.workspaceRoot, records: read.result.records };
};

/**
 * Read the declared decision kinds once and return the covering decisions of
 * a member. `root` is the workspace root on disk and `rootDir` the same from
 * the git top (`""` at the top).
 */
export async function memberDecisionsReader(
  declaration: Declaration,
  root: string,
  rootDir: string,
  read: DecisionKindReader = defaultReader,
): Promise<(member: { name: string; dir: string }) => string[]> {
  const kinds: ReadKind[] = [];
  for (const d of declaredRecordKinds(declaration)) {
    try {
      const r = await read(declaredKindFile(d, root), root);
      if (r.loaded.kind.work) continue;
      const byId = new Map<string, RecordEntry>();
      for (const v of r.records) if (v.id !== null) byId.set(v.id, v);
      kinds.push({ loaded: r.loaded, top: r.top, prefix: r.workspaceRoot === "." ? "" : r.workspaceRoot, records: r.records, byId });
    } catch {
      // A kind that can't be read covers nothing here; workspace check and records report why.
    }
  }
  // When each current decision was decided, read once per kind on first need.
  const decidedOn = new Map<ReadKind, Map<string, string | null>>();
  const decidedDate = (k: ReadKind, v: RecordEntry): string | null => {
    if (!k.loaded.kind.approval || !k.top) return null;
    let dates = decidedOn.get(k);
    if (!dates) {
      const current = k.records.filter((r) => r.id !== null && r.supersededBy === null).map((r) => r.path);
      const decided = decidedCommits(k.top, "HEAD", current, k.loaded.kind);
      dates = new Map(current.map((p) => [p, decided.get(p)?.date ?? null]));
      decidedOn.set(k, dates);
    }
    return dates.get(v.path) ?? null;
  };

  return (member) => {
    const memberFull = joinPath(rootDir, member.dir);
    const ranked: { key: DecisionRankKey; label: string }[] = [];
    for (const k of kinds) {
      const field = k.loaded.kind.constrains?.field;
      if (!field) continue;
      const name = k.loaded.kind.name;
      /** How each record covers the member: the relevance and the longest covering path entry. */
      const covers = (v: RecordEntry): { relevance: WhyRelevance; specificity: number } | null => {
        const list = v.data?.[field];
        if (!Array.isArray(list)) return null;
        let path = 0;
        let byMember = false;
        let inside = false;
        for (const entry of list) {
          if (typeof entry !== "string") continue;
          if (entry.startsWith("member:")) {
            if (entry.slice("member:".length) === member.name) byMember = true;
          } else if (entry.startsWith("path:")) {
            const p = entry.slice("path:".length);
            if (!isWorkspacePath(p)) continue;
            const full = joinPath(k.prefix, p);
            if (memberFull !== "" && constraintCovers(full, memberFull)) path = Math.max(path, entry.length);
            else if (memberFull === "" || full.startsWith(`${memberFull}/`)) {
              // Inside the member's directory, and not in a member nested in it.
              const inWorkspace = rootDir === "" ? full : full.startsWith(`${rootDir}/`) ? full.slice(rootDir.length + 1) : null;
              if (inWorkspace !== null && memberHolding(inWorkspace, declaration.members) === member.name) inside = true;
            }
          }
        }
        if (path > 0) return { relevance: "path", specificity: path };
        if (byMember) return { relevance: "member", specificity: 0 };
        return inside ? { relevance: "related", specificity: 0 } : null;
      };
      // Each covering record, and the current record at the end of its supersession chain.
      const current = new Set<string>();
      for (const v of k.records) {
        if (v.id === null || covers(v) === null) continue;
        let at: RecordEntry = v;
        const seen = new Set<string>();
        while (at.supersededBy !== null && !seen.has(at.id!)) {
          seen.add(at.id!);
          const next = k.byId.get(at.supersededBy);
          if (!next) break;
          at = next;
        }
        if (at.supersededBy === null && at.id !== null) current.add(at.id);
      }
      for (const id of current) {
        const v = k.byId.get(id)!;
        // A decision in the list only through the chain is related, as in why.
        const c = covers(v) ?? { relevance: "related" as const, specificity: 0 };
        ranked.push({
          label: `${name}/${id}`,
          key: {
            id: `record:${name}/${id}`,
            current: true,
            relevance: c.relevance,
            lines: 0,
            closed: v.state !== null && (k.loaded.kind.closedStates ?? []).includes(v.state),
            specificity: c.specificity,
            decidedOn: decidedDate(k, v),
          },
        });
      }
    }
    return ranked.sort((a, b) => compareDecisionRank(a.key, b.key)).map((r) => r.label);
  };
}
