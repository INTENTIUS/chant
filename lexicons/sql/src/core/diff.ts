/**
 * Identity and renames between two schemas, the same in every dialect
 * (#3047 question 3).
 *
 * An object is identified by its key: its export name between two revisions
 * of the declarations, its qualified name against a live server, which has no
 * export names. An `after` object whose key is new but whose `previously` hint
 * (`-- previously: <old name>`) names a `before` object with no `after`
 * counterpart is that object, renamed. What changed inside a matched pair,
 * and how each change is classed, is the dialect's.
 */

/** One side of a comparison: an object's identity and its canonical definition. */
export interface Keyed<O> {
  /** The object's identity in the comparison: an export name, or a qualified name against live. */
  key: string;
  canonical: O;
}

export type IdentityMatch<O> =
  | { kind: "created"; after: Keyed<O> }
  | { kind: "matched"; before: Keyed<O>; after: Keyed<O> }
  | { kind: "dropped"; before: Keyed<O> };

export interface IdentityRules<O> {
  /** The object's qualified name, which a `previously` hint may name. */
  qualified(o: O): string;
  /** The `-- previously: <old name>` hint on the object, if any. */
  previously(o: O): string | undefined;
  /**
   * The qualified names a hint may mean, tried in order after the hint as a
   * key: the hint itself, and for a dialect with schemas or databases the hint
   * qualified with the object's own.
   */
  previousNames(o: O, previously: string): readonly string[];
}

/**
 * Match `after` to `before` by key, then by rename hint. Returns every `after`
 * object in order, created or matched, then every `before` object no `after`
 * object matched, dropped.
 */
export function matchByIdentity<O>(before: readonly Keyed<O>[], after: readonly Keyed<O>[], rules: IdentityRules<O>): IdentityMatch<O>[] {
  const out: IdentityMatch<O>[] = [];
  const byKey = new Map(before.map((o) => [o.key, o]));
  const byQualified = new Map(before.map((o) => [rules.qualified(o.canonical), o]));
  const afterKeys = new Set(after.map((o) => o.key));
  const matched = new Set<string>();

  for (const a of after) {
    let b = byKey.get(a.key);
    const prev = rules.previously(a.canonical);
    if (!b && prev) {
      let candidate = byKey.get(prev);
      for (const name of rules.previousNames(a.canonical, prev)) candidate ??= byQualified.get(name);
      if (candidate && !afterKeys.has(candidate.key)) b = candidate;
    }
    if (!b) {
      out.push({ kind: "created", after: a });
      continue;
    }
    matched.add(b.key);
    out.push({ kind: "matched", before: b, after: a });
  }
  for (const b of before) if (!matched.has(b.key)) out.push({ kind: "dropped", before: b });
  return out;
}

/** The names whose values differ between two records, sorted. */
export function changedEntries(before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().filter((name) => before[name] !== after[name]);
}
