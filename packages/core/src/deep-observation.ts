/**
 * The deep observation contract (#1014) — what a lexicon's
 * `observeResourcesDeep()` is allowed to mean, and how a live property tree is
 * normalized before anything diffs it.
 *
 * `describeResources()` (./observation.ts) answers *whether* a declared entity
 * exists and carries a handful of scrubbed outputs. That is thin by design, and
 * it is why `lifecycle diff --live` only fires on a changed status, a replaced
 * physical id, or a changed stack output. The drift people actually care about
 * — a hand-edited security-group rule, an inline policy added in the console, a
 * flipped bucket setting — lives one level down, in properties nobody was
 * reading.
 *
 * This module adds the second, optional read: a normalized live property tree
 * per declared entity. It composes with the tri-state contract rather than
 * replacing it — {@link DeepObservationResult} carries the same
 * {@link UnobservedEntity} map, so a deep read that fails for one entity is
 * NOT-OBSERVED with a reason. A thin deep result is never allowed to pass for a
 * clean one.
 *
 * ## The hard half is noise, not reading
 *
 * A raw live model is mostly fields nobody declared and nobody changed: arns,
 * timestamps, generation counters, status subtrees, values the API filled in,
 * fields a controller owns, and orderings that carry no meaning (tag order,
 * policy statement order). Diffing that raw is all noise. So the contract is
 * three parts, and a lexicon implements the last two:
 *
 *   1. **The normalization pass** (here, shared) — canonical key order,
 *      hook-driven array order, secret masking, non-JSON values collapsed to
 *      {@link UNRESOLVED}.
 *   2. **The pruning hook** ({@link DeepNormalizationHooks.prune}) — the
 *      lexicon names its own read-only / server-populated / controller-managed /
 *      provider-defaulted fields.
 *   3. **The ordering hook** ({@link DeepNormalizationHooks.orderKey}) — the
 *      lexicon names which arrays are sets, and by what key they canonicalize.
 *
 * Both hooks are applied to the *declared* tree and the *live* tree with the
 * same rules, so the two sides are compared in the same shape. A hook sees
 * which side it is normalizing ({@link DeepNode.side}) and whether the same path
 * exists on the other side ({@link DeepNode.counterpart}) — that second flag is
 * what makes default subtraction expressible: a provider default is only noise
 * when nobody declared the property.
 */

import type { UnobservedEntity } from "./observation";

/**
 * A live property tree for one declared entity, already normalized by the
 * lexicon's hooks.
 */
export interface DeepResourceObservation {
  /** Entity type (e.g. `AWS::S3::Bucket`) — the same string `ResourceMetadata.type` carries. */
  type: string;
  /** Provider-assigned physical id, when the reader knows it. Correlates to `ResourceMetadata.physicalId`. */
  physicalId?: string;
  /** The normalized live property tree. JSON-safe. */
  properties: Record<string, unknown>;
}

/**
 * The deep observation envelope. Explicitly versioned and discriminated by
 * `deepObservation: "v1"`, for the same reason {@link
 * import("./observation").ObservationResult} is: the shape is a wire format
 * consumers branch on.
 *
 * There is deliberately no bare-map alternative here. `describeResources()`
 * accepts one for backward compatibility with lexicons written before #1089;
 * `observeResourcesDeep()` is new, so every implementation states its holes
 * from day one.
 */
export interface DeepObservationResult {
  /** Discriminant + wire version. */
  readonly deepObservation: "v1";
  /** OBSERVED-PRESENT, keyed by chant entity name. */
  resources: Record<string, DeepResourceObservation>;
  /**
   * NOT-OBSERVED, keyed by chant entity name — the entities whose *properties*
   * could not be read, with a total reason. An entity here may well exist and
   * may well be reported present by the thin `describeResources()`: the two
   * reads have independent verdicts, and a deep hole is a hole in the property
   * surface, not a claim about existence.
   */
  unobserved?: Record<string, UnobservedEntity>;
}

/** Normalized form every consumer works with. Both maps always present. */
export interface NormalizedDeepObservation {
  resources: Record<string, DeepResourceObservation>;
  unobserved: Record<string, UnobservedEntity>;
}

/** True when `value` is the versioned {@link DeepObservationResult} envelope. */
export function isDeepObservationResult(value: unknown): value is DeepObservationResult {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { deepObservation?: unknown }).deepObservation === "v1"
  );
}

/** Build a {@link DeepObservationResult}. Lexicons use this rather than writing the discriminant by hand. */
export function deepObservation(
  resources: Record<string, DeepResourceObservation>,
  unobserved?: Record<string, UnobservedEntity>,
): DeepObservationResult {
  return {
    deepObservation: "v1",
    resources,
    ...(unobserved && Object.keys(unobserved).length > 0 ? { unobserved } : {}),
  };
}

/**
 * Normalize a deep result. `undefined` (a lexicon that returned nothing at all)
 * normalizes to two empty maps — which reads as "every declared entity's
 * properties were read and there were none", so a reader that means "I could
 * not look" must say so with `unobservedAll()` rather than returning nothing.
 */
export function normalizeDeepObservation(
  value: DeepObservationResult | undefined,
): NormalizedDeepObservation {
  if (!value) return { resources: {}, unobserved: {} };
  return { resources: value.resources ?? {}, unobserved: value.unobserved ?? {} };
}

// ── Normalization pass ──────────────────────────────────────────────────────

/**
 * The placeholder a value takes when it is not JSON data — a class instance
 * (an unevaluated intrinsic like `Sub`/`Ref` in a declared tree), a function, a
 * symbol. The diff skips any path whose *declared* value is this: chant cannot
 * know what `Fn::Sub` resolves to without deploying, and guessing would report
 * every interpolated property as permanent drift.
 */
export const UNRESOLVED = "<chant:unresolved>";

/** Value a masked (secret-bearing) property takes. Matches the thin path's convention. */
export const MASKED = "[REDACTED]";

/**
 * Property-name patterns that mark a value secret-bearing. Deliberately narrow
 * and key-name based: broadening this to e.g. `/key/i` would mask an AWS tag's
 * `Key` field and every `*KeyName` reference, which is how masking turns into
 * its own drift signal.
 *
 * Shared with the thin snapshot path (`./lifecycle/snapshot.ts`), which warns
 * on the same names — one list, so the two paths cannot disagree about what
 * counts as a secret.
 */
export const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /password/i,
  /secret/i,
  /token/i,
  /private.?key/i,
  /credential/i,
  /connection.?string/i,
];

/** True when a property name looks secret-bearing (see {@link SENSITIVE_KEY_PATTERNS}). */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((p) => p.test(key));
}

/** Which tree a hook is being invoked on. */
export type DeepSide = "declared" | "live";

/** One node the normalization pass offers to {@link DeepNormalizationHooks.prune}. */
export interface DeepNode {
  /** Entity type being normalized (e.g. `AWS::S3::Bucket`). */
  entityType: string;
  /** Exact path from the property-tree root, array indices included: `Tags[0].Key`. */
  path: string;
  /**
   * The same path with array indices erased: `Tags[].Key`. Hooks match on this
   * — an index is an artifact of the read, never part of the rule.
   */
  pattern: string;
  /** Object key, or the array index as a string. */
  key: string;
  /** The raw value at this node, before recursion. */
  value: unknown;
  /** Which tree is being normalized. */
  side: DeepSide;
  /**
   * Whether this path also exists on the other tree — i.e. a live property that
   * was declared, or a declared property that came back live. Matched on the
   * exact path or the index-erased pattern, so `Tags[0].Value` counts as
   * declared when source declares any `Tags[].Value` (array order is not
   * canonical until *after* normalization, so an exact-index match would be a
   * coin flip inside arrays).
   *
   * `"unknown"` when the pass is running one-sided — a reader normalizing its
   * own output before returning it has no declared tree to consult. It is a
   * third state on purpose: a hook that treats "I wasn't told" as "not
   * declared" would prune a *declared* property out of the live tree at read
   * time, and the drift on it could never be reported.
   *
   * This is what makes provider-default subtraction expressible without a third
   * hook: a defaulted value is noise only when nobody declared the property
   * (`side === "live" && counterpart === "absent"`).
   */
  counterpart: "present" | "absent" | "unknown";
}

/** One array element the normalization pass offers to {@link DeepNormalizationHooks.orderKey}. */
export interface DeepArrayElement {
  entityType: string;
  /** Index-erased path of the containing array: `Tags`, `Policy.Statement`. */
  pattern: string;
  /** Exact path of the containing array. */
  path: string;
  /** The element, already normalized (pruned, key-sorted, masked). */
  element: unknown;
  index: number;
  side: DeepSide;
}

/**
 * The two hooks a lexicon supplies to opt into deep observation. Data on the
 * plugin, not methods on the read — the same rules must apply to the declared
 * tree, which no reader ever touches.
 */
export interface DeepNormalizationHooks {
  /**
   * Return true to drop this node (and everything under it) from the tree.
   *
   * This is where the lexicon names its noise classes: read-only and
   * server-populated fields (arns, timestamps, generation counters, status
   * subtrees), controller-managed fields, and provider defaults — the last of
   * those gated on `!node.counterpart` so a declared property is never pruned
   * out from under the diff. See {@link DeepNode.counterpart}.
   */
  prune?(node: DeepNode): boolean;
  /**
   * Return a canonical sort key for one element of an array, or `undefined` to
   * leave that array's order alone.
   *
   * An array is reordered only when *every* element yields a key — a partial
   * answer is treated as "I don't know how to canonicalize this", which keeps
   * an order-significant list (a pipeline's stages, a CIDR precedence list) in
   * the order the provider returned it.
   */
  orderKey?(element: DeepArrayElement): string | undefined;
}

/** Everything the pass needs besides the tree itself. */
export interface NormalizeDeepOptions {
  entityType: string;
  side: DeepSide;
  hooks?: DeepNormalizationHooks;
  /**
   * Paths present on the other tree, as produced by {@link deepPathSet}. Drives
   * {@link DeepNode.counterpart}. Omit and every node reports `"unknown"` —
   * the honest answer for a one-sided normalization.
   */
  counterpartPaths?: ReadonlySet<string>;
}

/** True for a value the pass will walk into rather than treat as a leaf. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** True for a value that can be compared and serialized as-is. */
function isJsonPrimitive(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function joinPath(parent: string, key: string): string {
  return parent ? `${parent}.${key}` : key;
}

function joinIndex(parent: string, index: number): string {
  return `${parent}[${index}]`;
}

function joinPattern(parent: string): string {
  return `${parent}[]`;
}

/**
 * Every path in a raw tree — both the exact form (`Tags[0].Value`) and the
 * index-erased pattern (`Tags[].Value`) — for {@link
 * NormalizeDeepOptions.counterpartPaths}. The two forms never collide (`[]` vs
 * `[0]`), so one set answers both questions.
 *
 * Computed on the *raw* tree, before pruning: whether a property was declared
 * cannot depend on whether the pruning rules kept it.
 */
export function deepPathSet(tree: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  const walk = (value: unknown, path: string, pattern: string): void => {
    if (path) {
      out.add(path);
      out.add(pattern);
    }
    if (Array.isArray(value)) {
      value.forEach((el, i) => walk(el, joinIndex(path, i), joinPattern(pattern)));
      return;
    }
    if (isPlainObject(value)) {
      for (const [k, v] of Object.entries(value)) walk(v, joinPath(path, k), joinPath(pattern, k));
    }
  };
  walk(tree, "", "");
  return out;
}

/**
 * Normalize one property tree: prune by hook, mask secret-bearing leaves,
 * canonicalize key order, canonicalize array order where the hook knows how,
 * and collapse anything that isn't JSON data to {@link UNRESOLVED}.
 *
 * Pure and total. Key order is canonicalized unconditionally because JSON
 * object order is not semantic and a provider is free to return it differently
 * on every read; array order is canonicalized only where the lexicon says the
 * array is a set, because list order often *is* semantic.
 */
/**
 * A container whose every member the rules pruned.
 *
 * The distinction it carries is between a value that was empty in the source
 * and one this pass emptied: `{}` a lexicon actually declared is a fact worth
 * diffing, while `{}` left behind after both of a rule's fields were subtracted
 * as provider defaults is a husk. Reporting the husk turns a suppressed default
 * into `SecurityGroupEgress[#{}]: <undeclared> → {}` — noise wearing the shape
 * of drift, which is the one thing the noise rules exist to prevent.
 *
 * Module-private: it never leaves this function's recursion.
 */
const EMPTIED = Symbol("emptied-by-pruning");

export function normalizeDeepProperties(
  tree: Record<string, unknown>,
  options: NormalizeDeepOptions,
): Record<string, unknown> {
  const { entityType, side, hooks, counterpartPaths } = options;

  const prune = (path: string, pattern: string, key: string, value: unknown): boolean => {
    if (!hooks?.prune) return false;
    return hooks.prune({
      entityType,
      path,
      pattern,
      key,
      value,
      side,
      counterpart: !counterpartPaths
        ? "unknown"
        : counterpartPaths.has(path) || counterpartPaths.has(pattern)
          ? "present"
          : "absent",
    });
  };

  const normalizeValue = (value: unknown, path: string, pattern: string, key: string): unknown => {
    if (isSensitiveKey(key)) return MASKED;
    if (isJsonPrimitive(value)) return value;

    if (Array.isArray(value)) {
      const elements: unknown[] = [];
      for (let i = 0; i < value.length; i++) {
        const elPath = joinIndex(path, i);
        const elPattern = joinPattern(pattern);
        if (prune(elPath, elPattern, String(i), value[i])) continue;
        const element = normalizeValue(value[i], elPath, elPattern, String(i));
        if (element === EMPTIED) continue;
        elements.push(element);
      }
      // An array that had elements and has none left was emptied by pruning,
      // not declared empty. Reporting `[]` for it is reporting the husk of a
      // value the rules just decided was noise.
      if (elements.length === 0 && value.length > 0) return EMPTIED;
      return orderElements(elements, path, pattern);
    }

    if (isPlainObject(value)) {
      const out: Record<string, unknown> = {};
      let had = 0;
      for (const childKey of Object.keys(value).sort()) {
        const childPath = joinPath(path, childKey);
        const childPattern = joinPath(pattern, childKey);
        const childValue = value[childKey];
        if (childValue === undefined) continue;
        had += 1;
        if (prune(childPath, childPattern, childKey, childValue)) continue;
        const child = normalizeValue(childValue, childPath, childPattern, childKey);
        if (child === EMPTIED) continue;
        out[childKey] = child;
      }
      if (Object.keys(out).length === 0 && had > 0) return EMPTIED;
      return out;
    }

    // A class instance (an unevaluated intrinsic), a function, a symbol, a
    // bigint — not JSON data, and not something the diff may guess at.
    return UNRESOLVED;
  };

  const orderElements = (elements: unknown[], path: string, pattern: string): unknown[] => {
    if (!hooks?.orderKey || elements.length < 2) return elements;
    const keyed: Array<{ key: string; element: unknown }> = [];
    for (let i = 0; i < elements.length; i++) {
      const key = hooks.orderKey({
        entityType,
        path,
        pattern,
        element: elements[i],
        index: i,
        side,
      });
      // A partial answer is not an answer — leave the order alone.
      if (key === undefined) return elements;
      keyed.push({ key, element: elements[i] });
    }
    keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return keyed.map((k) => k.element);
  };

  const root = normalizeValue(tree, "", "", "");
  return isPlainObject(root) ? root : {};
}

/** Longest order key that may appear inside a path segment before it stops being readable. */
const MAX_KEYED_SEGMENT = 60;

/** Context {@link flattenDeepProperties} needs to address set-like arrays by key. */
export interface FlattenDeepOptions {
  entityType: string;
  side: DeepSide;
  hooks?: DeepNormalizationHooks;
}

/**
 * Flatten a normalized tree to `path → leaf value`. Leaves are JSON primitives,
 * {@link UNRESOLVED}, and empty containers (an empty object/array is itself a
 * value — `Tags: []` differs from no `Tags` at all).
 *
 * Arrays the ordering hook can key are addressed **by that key**
 * (`Tags[#env].Value`) rather than by position. Positional paths would make the
 * diff shift-sensitive: one tag added in the console renames every tag after
 * it, so a single new tag reports as a change to every other tag and a
 * baseline entry stops matching the moment the set changes. Keying holds a
 * property's identity still while the set around it moves.
 *
 * Positional paths remain for arrays the hook cannot key, arrays whose keys
 * collide, and keys too long to read.
 */
export function flattenDeepProperties(
  tree: Record<string, unknown>,
  options?: FlattenDeepOptions,
): Map<string, unknown> {
  const out = new Map<string, unknown>();

  const indexSegments = (elements: unknown[], path: string, pattern: string): string[] => {
    const positional = elements.map((_, i) => joinIndex(path, i));
    if (!options?.hooks?.orderKey) return positional;
    const keys: string[] = [];
    for (let i = 0; i < elements.length; i++) {
      const key = options.hooks.orderKey({
        entityType: options.entityType,
        path,
        pattern,
        element: elements[i],
        index: i,
        side: options.side,
      });
      if (key === undefined || key.length > MAX_KEYED_SEGMENT) return positional;
      keys.push(key);
    }
    if (new Set(keys).size !== keys.length) return positional;
    return keys.map((k) => `${path}[#${k}]`);
  };

  const walk = (value: unknown, path: string, pattern: string): void => {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        out.set(path, []);
        return;
      }
      const segments = indexSegments(value, path, pattern);
      value.forEach((el, i) => walk(el, segments[i], joinPattern(pattern)));
      return;
    }
    if (isPlainObject(value)) {
      const keys = Object.keys(value);
      if (keys.length === 0) {
        out.set(path, {});
        return;
      }
      for (const k of keys) walk(value[k], joinPath(path, k), joinPath(pattern, k));
      return;
    }
    out.set(path, value);
  };
  for (const [k, v] of Object.entries(tree)) walk(v, k, k);
  return out;
}

/** Structural equality over JSON-shaped values, order-sensitive (post-canonicalization). */
export function deepValueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
