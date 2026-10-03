/** A Postgres schema diff as text (the shared core's report, with the refusal of expand-and-contract changes). */

import { renderChangeSet } from "../../core/classifier";
import { PG_CHANGE_CLASSES, PG_CLASSIFIER_RULES } from "./rules";
import type { PgSchemaDiff } from "./diff";

export function renderPgDiff(diff: PgSchemaDiff, opts: { title?: string } = {}): string {
  const rewrites = diff.changes.filter((c) => c.class === "rewrite").length;
  const trailer = [
    ...(rewrites > 0
      ? ["", `Warning: ${rewrites} change(s) rewrite or read a table under ACCESS EXCLUSIVE, which blocks its reads and writes until done; the rule names the form that does not.`]
      : []),
    ...(diff.refused.length > 0
      ? [
          "",
          `Refused: ${diff.refused.length} change(s) keep no old reader working when made in place. Each runs as expand and contract ` +
            "(add the new, write both, backfill, move readers, drop the old), as a migration Op, not as one statement.",
        ]
      : []),
  ];
  return renderChangeSet(diff, { ...(opts.title ? { title: opts.title } : {}), rules: PG_CLASSIFIER_RULES, classes: PG_CHANGE_CLASSES, trailer });
}
