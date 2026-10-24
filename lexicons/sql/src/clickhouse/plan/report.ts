/** A schema diff as text, for a terminal or a pull request (the shared core's report, with ClickHouse's refusal). */

import { renderChangeSet } from "../../core/classifier";
import { CHANGE_CLASSES, CLASSIFIER_RULES } from "./rules";
import type { SchemaDiff } from "./diff";
import { renderRebuildOps } from "./rebuild-handoff";
import { renderNamedCollections } from "../live/named-collections";

export function renderDiff(diff: SchemaDiff, opts: { title?: string } = {}): string {
  const unreadable = diff.unreadable ?? [];
  const refusedRead =
    unreadable.length > 0
      ? [
          "",
          `Refused: ${unreadable.length} object(s) in the declared databases could not be read, so this plan cannot say what changes for them:`,
          ...unreadable.map((u) => `  ${u.object} (${u.type}): ${u.reason}`),
        ]
      : [];
  const trailer = [
    ...refusedRead,
    ...renderNamedCollections(diff.namedCollections),
    ...(diff.rebuilds.length > 0
      ? [
          "",
          `Refused: ${diff.rebuilds.length} change(s) need a rebuild, which ClickHouse cannot make to the existing table. ` +
            "A rebuild runs as its own migration (create the new table, backfill, verify, swap), not in place.",
          ...renderRebuildOps(diff.rebuildOps ?? []),
        ]
      : []),
  ];
  const text = renderChangeSet(diff, { ...(opts.title ? { title: opts.title } : {}), rules: CLASSIFIER_RULES, classes: CHANGE_CLASSES, trailer });
  // The shared report prints no trailer under "No changes."; a missing named collection fails the plan all the same (#4395).
  const missing = renderNamedCollections(diff.namedCollections);
  return diff.changes.length === 0 && missing.length > 0 ? [text, ...missing].join("\n") : text;
}
