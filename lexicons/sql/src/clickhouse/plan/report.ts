/** A schema diff as text, for a terminal or a pull request. */

import { CLASSIFIER_RULES } from "./rules";
import type { SchemaDiff } from "./diff";

const CLASS_LABEL: Record<string, string> = {
  create: "create",
  drop: "drop",
  metadata: "metadata only",
  rewrite: "background rewrite",
  rebuild: "REBUILD",
};

export function renderDiff(diff: SchemaDiff, opts: { title?: string } = {}): string {
  const lines: string[] = [];
  if (opts.title) lines.push(opts.title, "");
  if (diff.changes.length === 0) {
    lines.push("No changes.");
    return lines.join("\n");
  }
  const byObject = new Map<string, typeof diff.changes>();
  for (const c of diff.changes) byObject.set(c.object, [...(byObject.get(c.object) ?? []), c]);
  for (const [object, changes] of byObject) {
    lines.push(object);
    for (const c of changes) {
      const rule = CLASSIFIER_RULES[c.rule];
      const values = c.before !== undefined && c.after !== undefined ? `: ${c.before} -> ${c.after}` : c.after !== undefined ? `: ${c.after}` : c.before !== undefined ? `: ${c.before}` : "";
      lines.push(`  [${CLASS_LABEL[c.class]}] ${c.field}${values}`);
      lines.push(`      ${c.rule} ${rule.title}${c.destructive ? " (destroys data)" : ""}. ${rule.restriction} ${rule.cite}`);
      if (c.note) lines.push(`      ${c.note}`);
    }
  }
  const counts = (["create", "metadata", "rewrite", "rebuild", "drop"] as const)
    .map((k) => [k, diff.changes.filter((c) => c.class === k).length] as const)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${CLASS_LABEL[k]}`);
  lines.push("", counts.join(", "));
  for (const h of diff.hints) lines.push(`hint: ${h}`);
  if (diff.rebuilds.length > 0) {
    lines.push(
      "",
      `Refused: ${diff.rebuilds.length} change(s) need a rebuild, which ClickHouse cannot make to the existing table. ` +
        "A rebuild runs as its own migration (create the new table, backfill, verify, swap), not in place.",
    );
  }
  return lines.join("\n");
}
