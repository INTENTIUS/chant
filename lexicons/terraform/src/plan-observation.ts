/**
 * The plan depth's projection (#4358): a saved plan's `show -json` document,
 * turned into the attributes an observed terraform block carries.
 *
 * The state read (`terraform show -json` over state) says what the last apply
 * recorded. A plan says what the next apply would do, and four facts exist
 * only there:
 *
 * | plan document | IR attribute |
 * |---|---|
 * | `resource_changes[].change.actions` | `planAction`, `planActions` |
 * | `resource_changes[].change.replace_paths`, `resource_changes[].action_reason` | `planReplacePaths`, `planActionReason` |
 * | `resource_changes[].change.after_unknown` | `planAfterUnknown` |
 * | `resource_drift[]`, `relevant_attributes[]` | `planDrift`, `planDriftAction`, `planRelevantAttributes` |
 *
 * plus `planChanges`, the attribute-level before and after of each planned
 * update or replace. `PLAN_ATTRIBUTE_NAMES` lists them for a consumer.
 *
 * ## Paths
 *
 * Every attribute path is one string: object keys joined with `.`, list
 * indexes and keys that are not identifiers in brackets, so
 * `lifecycle_commands[0].read`, `tags["kubernetes.io/role"]`. A `chant search
 * attr:planReplacePaths=triggers_replace` term matches by substring over that.
 *
 * ## Sensitive values never leave this module
 *
 * `before_sensitive` and `after_sensitive` are trees parallel to `before` and
 * `after`: `true` at a node marks that node and everything under it. A value
 * under a `true` node is replaced with `(sensitive)` before it is put on an
 * attribute, at any depth, so a sensitive value nested in a map is caught
 * exactly like a sensitive top-level attribute. Only leaves are ever emitted,
 * never a whole object, so no unwalked subtree can carry a secret past the
 * check.
 *
 * Flags alone are not enough, as a real plan shows: `terraform_data` copies
 * `input` to `output`, and the plan flags `input.token` sensitive while
 * leaving `output.token` unflagged with the same value in it. So every string
 * found under a sensitive flag anywhere in the document is collected first,
 * and any emitted value equal to one of them is redacted too. That catches a
 * copy; it cannot catch a secret a provider transformed (hashed, embedded in a
 * longer string), and the observation page says so.
 *
 * Nothing from `prior_state` is surfaced but each row's `id`, which is the
 * state read's rule too.
 */

/** What stands in for a value flagged sensitive, or equal to one that was. */
export const SENSITIVE_VALUE = "(sensitive)";

/** OpenTofu's and Terraform's own phrase for a value the plan cannot know yet. */
export const KNOWN_AFTER_APPLY = "(known after apply)";

/**
 * Every attribute the plan depth adds to an observed block, beside the state
 * read's `address`, `root`, `resourceType`, `mode` and `provider`. A block the
 * plan does not touch carries `planAction: "no-op"` and none of the optional
 * ones.
 */
export const PLAN_ATTRIBUTE_NAMES = [
  "planAction",
  "planActions",
  "planActionReason",
  "planReplacePaths",
  "planAfterUnknown",
  "planChanges",
  "planDrift",
  "planDriftAction",
  "planRelevantAttributes",
] as const;

/** One attribute that differs between two sides of a change, at leaf level. */
export interface PlanValueChange {
  /** Attribute path, see the module doc. */
  path: string;
  /** Before value, or `(sensitive)`. `null` where the side had no value. */
  before: unknown;
  /** After value, `(sensitive)`, or `(known after apply)`. */
  after: unknown;
  /** The instance this change belongs to, when the block has more than one. */
  instance?: string;
  /** On a drift entry: the plan reads this attribute (`relevant_attributes`). */
  relevant?: boolean;
}

/** One `resource_changes[]` entry, projected. */
export interface PlanInstanceChange {
  address: string;
  actions: string[];
  actionReason?: string;
  replacePaths: string[];
  afterUnknown: string[];
  changes: PlanValueChange[];
}

/** One `resource_drift[]` entry, projected. */
export interface PlanInstanceDrift {
  address: string;
  actions: string[];
  changes: PlanValueChange[];
}

/** A plan document, indexed for the plan depth. */
export interface PlanIndex {
  /**
   * `prior_state`, as the document carries it. The reader indexes it exactly
   * as the state read indexes state, so presence and ownership come from here.
   */
  priorState: unknown;
  /** `resource_changes[]`, by instance address. */
  changes: Map<string, PlanInstanceChange>;
  /** `resource_drift[]`, by instance address. */
  drift: Map<string, PlanInstanceDrift>;
  /** `relevant_attributes[]`, by instance address: the attribute paths the plan read. */
  relevant: Map<string, string[]>;
}

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Render one path segment list as a single string. */
export function renderPath(segments: ReadonlyArray<string | number>): string {
  let out = "";
  for (const segment of segments) {
    if (typeof segment === "number") out += `[${segment}]`;
    else if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(segment)) out += out ? `.${segment}` : segment;
    else out += `[${JSON.stringify(segment)}]`;
  }
  return out;
}

/** A path from the document (`replace_paths[]`, `relevant_attributes[].attribute`), rendered. */
function documentPath(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const segments = value.filter((s): s is string | number => typeof s === "string" || typeof s === "number");
  return segments.length > 0 ? renderPath(segments) : undefined;
}

/** The child of a parallel boolean tree at `key`. `true` is inherited by every descendant. */
function child(tree: unknown, key: string | number): unknown {
  if (tree === true) return true;
  if (Array.isArray(tree)) return typeof key === "number" ? tree[key] : undefined;
  if (isRecord(tree)) return tree[String(key)];
  return undefined;
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (isRecord(a) && isRecord(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && same(a[k], b[k]));
  }
  return false;
}

/** Every string leaf under a `true` node of `flags`, into `out`. */
function collectSensitive(value: unknown, flags: unknown, out: Set<string>): void {
  if (flags === true) {
    const walk = (v: unknown): void => {
      if (typeof v === "string" && v.length > 0) out.add(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (isRecord(v)) Object.values(v).forEach(walk);
    };
    walk(value);
    return;
  }
  if (Array.isArray(value)) value.forEach((v, i) => collectSensitive(v, child(flags, i), out));
  else if (isRecord(value)) for (const [k, v] of Object.entries(value)) collectSensitive(v, child(flags, k), out);
}

/** Every path where `tree` is `true`, as rendered paths. */
function truePaths(tree: unknown, at: Array<string | number> = []): string[] {
  if (tree === true) return at.length > 0 ? [renderPath(at)] : ["*"];
  if (Array.isArray(tree)) return tree.flatMap((v, i) => truePaths(v, [...at, i]));
  if (isRecord(tree)) return Object.entries(tree).flatMap(([k, v]) => truePaths(v, [...at, k]));
  return [];
}

/** A scalar for an emitted change: redacted when flagged or equal to a known sensitive string. */
function shown(value: unknown, flagged: boolean, secrets: ReadonlySet<string>): unknown {
  if (flagged) return SENSITIVE_VALUE;
  if (value === undefined) return null;
  if (typeof value === "string" && secrets.has(value)) return SENSITIVE_VALUE;
  return value;
}

const isContainer = (v: unknown): boolean => Array.isArray(v) || isRecord(v);

/**
 * The leaf-level differences between two sides of one change. Exported for
 * the redaction tests; see the module doc for the rules.
 */
export function diffChange(
  change: {
    before?: unknown;
    after?: unknown;
    before_sensitive?: unknown;
    after_sensitive?: unknown;
    after_unknown?: unknown;
  },
  secrets: ReadonlySet<string>,
): PlanValueChange[] {
  const out: PlanValueChange[] = [];

  const walk = (
    before: unknown,
    after: unknown,
    bs: unknown,
    as: unknown,
    au: unknown,
    at: Array<string | number>,
  ): void => {
    const path = renderPath(at) || "*";

    // Unknown until apply. The before side is still walked to its leaves when
    // it is a container, so each leaf keeps its own sensitivity, and the
    // after side of every leaf is the phrase.
    if (au === true) {
      if (bs !== true && isContainer(before) && Object.keys(before as object).length > 0) {
        const keys = Array.isArray(before) ? before.map((_, i) => i) : Object.keys(before as Rec).sort();
        for (const key of keys) {
          walk((before as Rec)[key as string], undefined, child(bs, key), undefined, true, [...at, key]);
        }
        return;
      }
      out.push({ path, before: isContainer(before) && bs !== true ? before : shown(before, bs === true, secrets), after: KNOWN_AFTER_APPLY });
      return;
    }

    if (same(before, after)) return;

    // A flagged node is emitted whole, as `(sensitive)`, and never walked:
    // there is nothing under it to show. A container beside a flag on the
    // other side is redacted too rather than walked without its flags.
    if (bs === true || as === true) {
      const side = (v: unknown, flagged: boolean): unknown =>
        v === undefined || v === null ? null : flagged || isContainer(v) ? SENSITIVE_VALUE : shown(v, false, secrets);
      out.push({ path, before: side(before, bs === true), after: side(after, as === true) });
      return;
    }

    if (Array.isArray(before) || Array.isArray(after)) {
      const b = Array.isArray(before) ? before : [];
      const a = Array.isArray(after) ? after : [];
      for (let i = 0; i < Math.max(b.length, a.length); i++) {
        walk(b[i], a[i], child(bs, i), child(as, i), child(au, i), [...at, i]);
      }
      return;
    }
    if (isRecord(before) || isRecord(after)) {
      const b = isRecord(before) ? before : {};
      const a = isRecord(after) ? after : {};
      for (const key of [...new Set([...Object.keys(b), ...Object.keys(a)])].sort()) {
        walk(b[key], a[key], child(bs, key), child(as, key), child(au, key), [...at, key]);
      }
      return;
    }

    out.push({ path, before: shown(before, false, secrets), after: shown(after, false, secrets) });
  };

  walk(change.before, change.after, change.before_sensitive, change.after_sensitive, change.after_unknown, []);
  return out;
}

function actionsOf(change: Rec): string[] {
  return Array.isArray(change.actions) ? change.actions.filter((a): a is string => typeof a === "string") : [];
}

/**
 * Index a `show -json <planfile>` document. Unknown fields are ignored and a
 * missing section reads as empty, the same tolerance the state read has.
 */
export function indexPlan(document: unknown): PlanIndex {
  const doc = isRecord(document) ? document : {};
  const rawChanges = Array.isArray(doc.resource_changes) ? doc.resource_changes.filter(isRecord) : [];
  const rawDrift = Array.isArray(doc.resource_drift) ? doc.resource_drift.filter(isRecord) : [];

  // Pass one: every string under a sensitive flag, anywhere in the document.
  const secrets = new Set<string>();
  for (const entry of [...rawChanges, ...rawDrift]) {
    const change = isRecord(entry.change) ? entry.change : {};
    collectSensitive(change.before, change.before_sensitive, secrets);
    collectSensitive(change.after, change.after_sensitive, secrets);
  }

  const relevant = new Map<string, string[]>();
  for (const entry of Array.isArray(doc.relevant_attributes) ? doc.relevant_attributes.filter(isRecord) : []) {
    const address = asString(entry.resource);
    const path = documentPath(entry.attribute);
    if (!address || !path) continue;
    const list = relevant.get(address) ?? [];
    if (!list.includes(path)) list.push(path);
    relevant.set(address, list);
  }

  const changes = new Map<string, PlanInstanceChange>();
  for (const entry of rawChanges) {
    const address = asString(entry.address);
    if (!address || !isRecord(entry.change)) continue;
    const change = entry.change;
    const replacePaths = (Array.isArray(change.replace_paths) ? change.replace_paths : [])
      .map(documentPath)
      .filter((p): p is string => p !== undefined);
    const actions = actionsOf(change);
    const updates = actions.includes("update") || (actions.includes("create") && actions.includes("delete"));
    changes.set(address, {
      address,
      actions,
      ...(asString(entry.action_reason) ? { actionReason: asString(entry.action_reason) } : {}),
      replacePaths,
      afterUnknown: truePaths(change.after_unknown),
      // Only an update or a replace compares two states of one object. A
      // create has no before and a delete no after: neither is an attribute
      // that moved, and both are already the action itself.
      changes: updates ? diffChange(change, secrets) : [],
    });
  }

  const drift = new Map<string, PlanInstanceDrift>();
  for (const entry of rawDrift) {
    const address = asString(entry.address);
    if (!address || !isRecord(entry.change)) continue;
    const reads = relevant.get(address) ?? [];
    drift.set(address, {
      address,
      actions: actionsOf(entry.change),
      changes: diffChange(entry.change, secrets).map((c) =>
        reads.some((r) => c.path === r || c.path.startsWith(`${r}.`) || c.path.startsWith(`${r}[`))
          ? { ...c, relevant: true }
          : c,
      ),
    });
  }

  return { priorState: doc.prior_state, changes, drift, relevant };
}

/**
 * The block address an instance address belongs to: every instance key
 * removed, on the resource and on each module call, so `module.a[0].x.y["k"]`
 * belongs to `module.a.x.y`.
 */
export function blockAddressOf(instance: string): string {
  return instance.replace(/\[(?:"(?:[^"\\]|\\.)*"|\d+)\]/g, "");
}

/** One action list as one word: `replace` for either order of delete and create. */
export function actionWord(actions: readonly string[]): string {
  if (actions.includes("create") && actions.includes("delete")) return "replace";
  if (actions.length === 0) return "no-op";
  return actions.join(",");
}

/**
 * The plan attributes of one declared block, aggregated over its instances.
 * `instances` are the block's instance addresses in `prior_state`; a block in
 * the plan that has none there is a planned create, which the reader reports
 * absent before it ever asks for these.
 */
export function planAttributesFor(address: string, index: PlanIndex): Record<string, unknown> {
  const mine = <T>(map: Map<string, T>): Array<[string, T]> =>
    [...map].filter(([instance]) => blockAddressOf(instance) === address).sort(([a], [b]) => a.localeCompare(b));
  const changes = mine(index.changes);
  const drift = mine(index.drift);
  const relevant = mine(index.relevant);
  const many = new Set([...changes, ...drift].map(([instance]) => instance)).size > 1;
  const tag = (instance: string, c: PlanValueChange): PlanValueChange =>
    many || instance !== address ? { ...c, instance } : c;

  const words = [...new Set(changes.map(([, c]) => actionWord(c.actions)))].sort();
  const reasons = [...new Set(changes.map(([, c]) => c.actionReason).filter((r): r is string => !!r))].sort();
  const replacePaths = [...new Set(changes.flatMap(([, c]) => c.replacePaths))].sort();
  const afterUnknown = [...new Set(changes.flatMap(([, c]) => c.afterUnknown))].sort();
  const valueChanges = changes.flatMap(([instance, c]) => c.changes.map((v) => tag(instance, v)));
  const driftChanges = drift.flatMap(([instance, d]) => d.changes.map((v) => tag(instance, v)));
  const driftWords = [...new Set(drift.map(([, d]) => actionWord(d.actions)))].sort();
  const relevantPaths = [...new Set(relevant.flatMap(([, paths]) => paths))].sort();

  return {
    planAction: words.length > 0 ? words.join(",") : "no-op",
    ...(changes.length > 0 ? { planActions: Object.fromEntries(changes.map(([i, c]) => [i, c.actions])) } : {}),
    ...(reasons.length > 0 ? { planActionReason: reasons.join(",") } : {}),
    ...(replacePaths.length > 0 ? { planReplacePaths: replacePaths } : {}),
    ...(afterUnknown.length > 0 ? { planAfterUnknown: afterUnknown } : {}),
    ...(valueChanges.length > 0 ? { planChanges: valueChanges } : {}),
    ...(drift.length > 0 ? { planDriftAction: driftWords.join(","), planDrift: driftChanges } : {}),
    ...(relevantPaths.length > 0 ? { planRelevantAttributes: relevantPaths } : {}),
  };
}
