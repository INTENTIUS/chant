/** A schema diff as text, for a terminal or a pull request (the shared core's report, with ClickHouse's refusal). */

import { renderChangeSet } from "../../core/classifier";
import { CHANGE_CLASSES, CLASSIFIER_RULES } from "./rules";
import type { SchemaDiff } from "./diff";
import { renderRebuildOps } from "./rebuild-handoff";

export function renderDiff(diff: SchemaDiff, opts: { title?: string } = {}): string {
  const trailer =
    diff.rebuilds.length > 0
      ? [
          "",
          `Refused: ${diff.rebuilds.length} change(s) need a rebuild, which ClickHouse cannot make to the existing table. ` +
            "A rebuild runs as its own migration (create the new table, backfill, verify, swap), not in place.",
          ...renderRebuildOps(diff.rebuildOps ?? []),
        ]
      : [];
  return renderChangeSet(diff, { ...(opts.title ? { title: opts.title } : {}), rules: CLASSIFIER_RULES, classes: CHANGE_CLASSES, trailer });
}
