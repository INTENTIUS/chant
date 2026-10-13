/**
 * The change classifier's framework, the same in every dialect: the shape of
 * a rule, a classified change, `classifyDisruption()` over a dialect's rules,
 * and the text report.
 *
 * The classes are data, one set per dialect. ClickHouse classes a change by
 * whether `ALTER` can make it (metadata, background rewrite, rebuild); another
 * dialect classes by the lock a change takes and whether it rewrites the
 * table. Each dialect declares its classes with {@link ChangeClasses} and its
 * rules with {@link classifierRule}, every rule citing the database's own
 * documentation for the restriction behind it.
 */

import type { DisruptionQuery, DisruptionVerdict, Disruption } from "@intentius/chant/lifecycle/disruption";

/** One way a declared object can change, the class of change it is on the server, and why. */
export interface ClassifierRule<C extends string = string> {
  id: string;
  class: C;
  title: string;
  /** The restriction, in a sentence. */
  restriction: string;
  /** The documentation page the restriction is stated on. */
  cite: string;
}

export const classifierRule = <C extends string>(id: string, cls: C, title: string, restriction: string, cite: string): ClassifierRule<C> => ({
  id,
  class: cls,
  title,
  restriction,
  cite,
});

/** A dialect's change classes as data: their order in a report, their labels, and what each costs to apply. */
export interface ChangeClasses<C extends string> {
  /** The order a report counts the classes in. */
  order: readonly C[];
  /** Each class as a report names it. */
  label: Readonly<Record<C, string>>;
  /** Each class as `classifyDisruption()` reports it. */
  disruption: Readonly<Record<C, Disruption>>;
}

/** One classified change to one object. */
export interface ClassifiedChange<R extends string = string, C extends string = string> {
  /** The object's identity. */
  object: string;
  /** What changed, e.g. `columns.kind.type`, `orderBy`, `name`. */
  field: string;
  before?: string;
  after?: string;
  rule: R;
  class: C;
  /** Data is removed and not recoverable. */
  destructive?: boolean;
  /** What a reader should know besides the rule. */
  note?: string;
}

/** A classified change from `before` to `after`, its class read from `rules`. */
export function classifiedChange<R extends string, C extends string>(
  rules: Readonly<Record<R, ClassifierRule<C>>>,
  object: string,
  field: string,
  rule: R,
  before?: unknown,
  after?: unknown,
  extra: Partial<ClassifiedChange<R, C>> = {},
): ClassifiedChange<R, C> {
  return {
    object,
    field,
    ...(before !== undefined ? { before: String(before) } : {}),
    ...(after !== undefined ? { after: String(after) } : {}),
    rule,
    class: rules[rule].class,
    ...extra,
  };
}

/** The changes between two schemas, and hints for the author. */
export interface ChangeSet<Ch extends ClassifiedChange = ClassifiedChange> {
  changes: Ch[];
  /** Hints for the author: a drop and an add that look like a rename. */
  hints: string[];
}

// ── classifyDisruption() ────────────────────────────────────────────────

const RANK: Record<Disruption, number> = { "in-place": 0, rolling: 1, replace: 2, destroy: 3, unknown: 4 };

export interface DisruptionClassifier<R extends string, C extends string> {
  /** The entity type prefix the dialect's objects carry (`ClickHouse::`); other types are left out. */
  typePrefix: string;
  rules: Readonly<Record<R, ClassifierRule<C>>>;
  classes: Pick<ChangeClasses<C>, "disruption">;
  /** The rule a changed path falls under, `ambiguous` when the path alone cannot say, undefined when no rule covers it. */
  ruleFor(path: string): R | "ambiguous" | undefined;
  /** The detail of an `unknown` verdict: why the paths cannot decide, and what does. */
  ambiguousDetail: string;
}

/**
 * `classifyDisruption()` over a dialect's rules: each update's disruption is
 * the worst class among its changed paths, and `unknown` when any path cannot
 * be classified from the path alone.
 */
export function classifyDisruptionWith<R extends string, C extends string>(
  classifier: DisruptionClassifier<R, C>,
  options: { environment: string; changes: DisruptionQuery[] },
): Record<string, DisruptionVerdict> {
  const out: Record<string, DisruptionVerdict> = {};
  for (const q of options.changes) {
    if (q.type !== undefined && !q.type.startsWith(classifier.typePrefix)) continue;
    let level: Disruption = "in-place";
    const because: string[] = [];
    const rules = new Set<string>();
    let ambiguous = false;
    for (const d of q.deltas) {
      const r = classifier.ruleFor(d.path);
      if (r === undefined || r === "ambiguous") {
        ambiguous = true;
        because.push(d.path);
        continue;
      }
      const l = classifier.classes.disruption[classifier.rules[r].class]!;
      if (RANK[l] > RANK[level]) {
        level = l;
        because.length = 0;
      }
      if (RANK[l] === RANK[level]) because.push(d.path);
      rules.add(r);
    }
    if (ambiguous) {
      out[q.name] = { disruption: "unknown", because, detail: classifier.ambiguousDetail };
      continue;
    }
    out[q.name] = {
      disruption: level,
      because,
      detail: [...rules].map((r) => `${r} ${classifier.rules[r as R].title}`).join("; "),
    };
  }
  return out;
}

// ── The report ──────────────────────────────────────────────────────────

/**
 * A change set as text, for a terminal or a pull request: each object's
 * changes with their class, rule, restriction and citation, then a count per
 * class and the hints. `trailer` is the dialect's closing lines (what a plan
 * refuses and what to run instead); it is left out when nothing changed.
 */
export function renderChangeSet<R extends string, C extends string>(
  diff: ChangeSet<ClassifiedChange<R, C>>,
  opts: { title?: string; rules: Readonly<Record<R, ClassifierRule<C>>>; classes: Pick<ChangeClasses<C>, "order" | "label">; trailer?: readonly string[] },
): string {
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
      const rule = opts.rules[c.rule];
      const values = c.before !== undefined && c.after !== undefined ? `: ${c.before} -> ${c.after}` : c.after !== undefined ? `: ${c.after}` : c.before !== undefined ? `: ${c.before}` : "";
      lines.push(`  [${opts.classes.label[c.class]}] ${c.field}${values}`);
      lines.push(`      ${c.rule} ${rule.title}${c.destructive ? " (destroys data)" : ""}. ${rule.restriction} ${rule.cite}`);
      if (c.note) lines.push(`      ${c.note}`);
    }
  }
  const counts = opts.classes.order
    .map((k) => [k, diff.changes.filter((c) => c.class === k).length] as const)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${opts.classes.label[k]}`);
  lines.push("", counts.join(", "));
  for (const h of diff.hints) lines.push(`hint: ${h}`);
  if (opts.trailer) lines.push(...opts.trailer);
  return lines.join("\n");
}
