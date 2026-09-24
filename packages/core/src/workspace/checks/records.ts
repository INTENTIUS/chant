/**
 * The record checks, WSP111 to WSP114 (#2549; #2524 D4, D18).
 *
 * With `--kind <kind file>`, `chant workspace check` reads the records the
 * kind locates, in the tree it checks, and reports the files they pin by hash
 * that have changed or gone since. A decision stays valid when its evidence
 * drifts, so drift is a warning: it asks for the decision to be looked at
 * again, and the declaration's `checks` can raise it to an error.
 *
 * | Id | Finds |
 * |---|---|
 * | WSP111 | a pinned file whose bytes no longer hash to the pinned sha256 |
 * | WSP112 | a pinned file that does not exist |
 * | WSP113 | a pinned file that a superseding record pins at the old hash: the artifact did not follow the decision |
 * | WSP114 | the records of `--kind` can't be read (fixed) |
 * | WSP115 | a record kind the declaration names is missing or does not load as one (fixed, #2680) |
 */

import type { WorkspaceCheck, WorkspaceDiagnostic } from "../checks";
import type { ReadErrorCode, RecordEntry } from "../records";

/** The records `check --kind` read, or why they could not be read. */
export type RecordFacts =
  | { kind: string; records: readonly (RecordEntry & { file: string })[] }
  | { kind: string; error: { code: ReadErrorCode; message: string } };

function warningFindings(check: WorkspaceCheck, facts: RecordFacts | undefined, code: "asset-drift" | "asset-missing" | "asset-stale"): WorkspaceDiagnostic[] {
  if (!facts || "error" in facts) return [];
  const out: WorkspaceDiagnostic[] = [];
  for (const r of facts.records) {
    // A superseded record's evidence no longer backs anything current.
    if (r.supersededBy !== null) continue;
    for (const w of r.warnings) {
      if (w.code !== code) continue;
      out.push({ checkId: check.id, severity: check.severity, message: `${r.id ?? r.path}: ${w.message}`, pointer: "", file: r.file });
    }
  }
  return out;
}

export const RECORD_CHECKS: readonly WorkspaceCheck[] = [
  {
    id: "WSP111",
    name: "record-asset-drift",
    description: "Every file a current record pins by hash still hashes to the pinned sha256. A changed file asks for the record to be revisited.",
    severity: "warning",
    configurable: true,
    check(ctx) {
      return warningFindings(this, ctx.facts?.records, "asset-drift");
    },
  },
  {
    id: "WSP112",
    name: "record-asset-missing",
    description: "Every file a current record pins by hash exists.",
    severity: "warning",
    configurable: true,
    check(ctx) {
      return warningFindings(this, ctx.facts?.records, "asset-missing");
    },
  },
  {
    id: "WSP113",
    name: "record-asset-stale",
    description: "No current record pins a file at the same hash as a record it supersedes while the file is unchanged since: when a decision changes, the artifacts it rests on follow.",
    severity: "warning",
    configurable: true,
    check(ctx) {
      return warningFindings(this, ctx.facts?.records, "asset-stale");
    },
  },
  {
    id: "WSP114",
    name: "records-unreadable",
    description: "The records of the kind named with --kind can be read.",
    severity: "error",
    configurable: false,
    check(ctx) {
      const facts = ctx.facts?.records;
      if (!facts || !("error" in facts)) return [];
      return [{ checkId: this.id, severity: this.severity, message: `--kind ${facts.kind}: ${facts.error.code}: ${facts.error.message}`, pointer: "" }];
    },
  },
  {
    id: "WSP115",
    name: "record-kind-unloadable",
    description: "Every record kind the declaration names is a file that exports a valid recordKind, with the schema it names.",
    severity: "error",
    configurable: false,
    check(ctx) {
      return (ctx.facts?.declaredKinds ?? [])
        .filter((k) => k.reason !== null)
        .map((k) => ({
          checkId: this.id,
          severity: this.severity,
          message: `${k.declared.member === null ? "the workspace" : `member ${k.declared.member}`} declares the record kind ${k.declared.kind}, which can't be loaded: ${k.reason!.code}: ${k.reason!.message}`,
          ...(k.declared.member !== null ? { entity: k.declared.member } : {}),
          pointer: `${k.declared.pointer}/kind`,
        }));
    },
  },
];
