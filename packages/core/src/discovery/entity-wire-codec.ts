/**
 * chant #1045 (Phase 1) — the JSON wire format for a discovered, named,
 * ref-resolved entity set. Split out of `./entity-wire.ts` in Phase 2 so this
 * codec (`encodeEntitySet`/`decodeEntitySet`, no dependency on `discover()`
 * or anything that pulls in the `typescript` compiler package) can be
 * bundled ALONE into the sandboxed child's driver (`./sandbox/driver.ts`)
 * without dragging in `discover()`'s whole fold/import graph — `entity-
 * wire.ts` re-exports everything here unchanged, so nothing outside this
 * pair of files needs to know about the split.
 *
 * `discover()` (./index.ts) produces a `Map<string, Declarable>` whose cross-
 * entity references are live object identity: an `AttrRef.parent` is a
 * `WeakRef<object>`, and a resource can embed ANOTHER resource directly as a
 * prop value (e.g. `DependsOn: [otherResource]`) — the lexicon serializers
 * detect this by looking the embedded object up (by identity) in a
 * `Map<Declarable, string>` built from the very same entities map
 * (`serializer-walker.ts`'s `resourceRef` dispatch; see also
 * `resource-attributes.ts`'s `resolveDependsOn`). Neither a `WeakRef` nor bare
 * object identity survives a process boundary.
 *
 * {@link encodeEntitySet} converts that live map into plain, JSON-safe data:
 * every identity-based reference (an `AttrRef`, or a whole entity embedded by
 * value) becomes a name-keyed marker instead. {@link decodeEntitySet} is the
 * inverse — it rebuilds a live `Map<string, Declarable>` whose entities are
 * BEHAVIORALLY indistinguishable from what `discover()` would have produced
 * in-process: real `AttrRef` instances (several call sites downstream key off
 * `instanceof AttrRef`, not just duck typing — `intrinsic-interpolation.ts`'s
 * `defaultInterpolationSerializer`, `discovery/graph.ts`'s
 * `buildDependencyGraph`, `build.ts`'s `detectCrossLexiconRefs`/
 * `computeStackGraph` — so a plain `{__attrRef}` envelope alone is not
 * enough), and whole-entity embeds restored to the SAME object reference
 * (not a structurally-equal clone), so `entityNames.get(decl)` keeps working
 * by identity exactly as it does today.
 *
 * `serializer-walker.ts`'s `walkValue` needs NO changes for this: it already
 * falls back to reading a plain `{__attrRef}` envelope (added for intrinsics
 * whose own `toJSON()` embeds one). `decodeEntitySet` goes further and
 * reconstructs the real class so every OTHER `instanceof AttrRef` call site
 * keeps working too, not just the walker.
 *
 * Naming happens exactly once, inside the boundary — `resolveAttrRefs`
 * (./resolve.ts) runs as part of `discover()`, before `encodeEntitySet` is
 * ever called (in-process), or inside the sandboxed child, over just the
 * run-fallback subset (chant #1045 Phase 2, `./sandbox/run.ts`). This module
 * does not re-derive names; it only carries already-resolved ones across.
 *
 * Scope (see the chant#1045 PR description for the full list): resource and
 * property `Declarable`s, `StackOutput` (itself a marked `Declarable`), and
 * `LexiconOutput` (not a `Declarable` — it is carried as its own wire form)
 * all round-trip. A `ChildProjectInstance` (`nestedStack()`) does not — its
 * `outputs` field is a lazy `Proxy`, not data — and {@link encodeEntitySet}
 * throws rather than silently mis-encoding it. No corpus entry under
 * `examples/` or any lexicon's `examples/` directory uses `nestedStack()`
 * today.
 */

import { DECLARABLE_MARKER, type Declarable } from "../declarable";
import { AttrRef } from "../attrref";
import { INTRINSIC_MARKER, type Intrinsic } from "../intrinsic";
import { isAttrRefLike } from "../utils";
import { isLexiconOutput, LexiconOutput } from "../lexicon-output";
import { isChildProject } from "../child-project";

/**
 * A JSON-safe value tree: primitives, arrays/objects, and four marker shapes
 * that stand in for what can't cross a process boundary by identity:
 *
 * - `__attrRef` — an `AttrRef` (attribute reference), keyed by the parent
 *   entity's already-resolved logical name.
 * - `__entityRef` — a WHOLE entity embedded by value (e.g. `DependsOn:
 *   [otherResource]`), keyed by that entity's logical name.
 * - `__property` — a nested, unnamed property-kind `Declarable` (not tracked
 *   in the entities map, so it carries its own `lexicon`/`entityType`/`props`
 *   inline rather than by reference).
 * - `__intrinsic` — a lexicon intrinsic (`Sub`, `Join`, `Ref`, a pseudo-
 *   parameter, gitlab's `!reference`, github's `${{ }}` `Expression`, …).
 *   `value` is its already-called `toJSON()` output (Phase 0 confirmed every
 *   intrinsic in this codebase implements `toJSON` and holds no
 *   function/closure fields, so this is lossless). `yaml` is present only
 *   when the intrinsic ALSO implements the optional `toYAML()` method the
 *   gitlab and github serializers duck-type (`"toYAML" in value`) ahead of
 *   the generic `toJSON` dispatch, for a YAML-native form that differs from
 *   the JSON one (gitlab's `!reference [a, b]` tag vs. its plain `["a","b"]`
 *   JSON array) — capturing only `toJSON()` would silently lose that native
 *   form. `refs` additionally captures any `AttrRef`/whole-entity reference
 *   found while walking the intrinsic's OWN fields (not through `toJSON()`)
 *   — `buildDependencyGraph` and `detectCrossLexiconRefs`/`computeStackGraph`
 *   walk raw entity property trees looking for `instanceof AttrRef`/a
 *   tracked `Declarable`, not through `toJSON()`, so a ref nested inside e.g.
 *   a `Sub` template needs to still be discoverable post-decode for
 *   cross-lexicon output auto-detection and dependency ordering to keep
 *   working.
 */
export type WireValue =
  | null
  | string
  | number
  | boolean
  | WireValue[]
  | { __attrRef: { entity: string; attribute: string } }
  | { __entityRef: { entity: string } }
  | { __property: { lexicon: string; entityType: string; props?: WireValue } }
  | { __intrinsic: { value: WireValue; yaml?: WireValue; refs: WireValue[] } }
  | { [key: string]: WireValue };

/** Wire form of one named, top-level `Declarable` entity (resource, property, or marked-Declarable output like `StackOutput`). */
export interface WireDeclarableEntity {
  form: "declarable";
  name: string;
  lexicon: string;
  entityType: string;
  kind?: "resource" | "property" | "output";
  props?: WireValue;
  attributes?: WireValue;
  /**
   * `.description` of every truthy own marker symbol on the entity (e.g.
   * `"chant.declarable"`, `"chant.stackOutput"`, a lexicon-specific one like
   * `"chant.aws.defaultTags"`). Every marker symbol in this codebase is
   * created with `Symbol.for(...)`, so `Symbol.for(description)` on decode
   * reliably recovers the SAME symbol a `X_MARKER in value` check looks for —
   * core doesn't need to know what any lexicon-specific marker means.
   */
  markers: string[];
  /**
   * Every other own enumerable field, beyond the fixed `lexicon`/`entityType`/
   * `kind`/`props`/`attributes` shape — covers both a resource's per-attribute
   * `AttrRef` fields (`vpcId`, `arn`, …) and plain-data fields on marker-
   * Declarables that aren't built via `createResource`/`createProperty`
   * (`StackOutput.sourceRef`/`description`, `DefaultTags.tags`,
   * `Parameter.parameterType`/`description`/`defaultValue`, …).
   */
  extra?: Record<string, WireValue>;
}

/** Wire form of one named `LexiconOutput` entity — not a `Declarable`, so it's carried as its own shape rather than forced into {@link WireDeclarableEntity}. */
export interface WireLexiconOutputEntity {
  form: "lexiconOutput";
  name: string;
  outputName: string;
  /** The wrapped `AttrRef` or `Intrinsic` — encodes to `{__attrRef}` or `{__intrinsic}` respectively (see {@link WireValue}). */
  ref: WireValue;
}

export type WireEntity = WireDeclarableEntity | WireLexiconOutputEntity;

/** A discovered, named, ref-resolved entity set, as pure JSON. */
export interface EntitySetWire {
  entities: WireEntity[];
}

const CORE_FIELD_NAMES = new Set(["lexicon", "entityType", "kind", "props", "attributes"]);

// ─────────────────────────────────────────────────────────────────────────
// Encode: live entities map → JSON-safe wire data.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Read a `LexiconOutput`'s internal ref without re-deriving it — see the
 * `_intrinsic`/`_sourceParent` fields in `../lexicon-output.ts`. When it was
 * built from an `AttrRef`, `LexiconOutput` keeps only the parent `WeakRef` +
 * attribute name (not the original `AttrRef` instance), so a fresh one is
 * synthesized here — its logical name must be set explicitly (from
 * `entityNames`, the same map every other reference in this module resolves
 * names through) since it never went through `resolveAttrRefs`.
 */
function lexiconOutputRef(output: LexiconOutput, entityNames: Map<unknown, string>): AttrRef | Intrinsic {
  if (output._intrinsic) return output._intrinsic;
  const parent = output._sourceParent?.deref();
  const parentName = parent ? entityNames.get(parent) : undefined;
  if (!parent || output.sourceAttribute === null || !parentName) {
    throw new Error(`encodeEntitySet: LexiconOutput "${output.outputName}" has neither a resolvable AttrRef parent nor an intrinsic`);
  }
  const ref = new AttrRef(parent, output.sourceAttribute);
  ref._setLogicalName(parentName);
  return ref;
}

/** Walk `root`'s OWN fields (not through `toJSON()`) collecting any `AttrRef`/tracked-entity reference found — see {@link WireValue}'s `__intrinsic.refs` doc. */
function collectEmbeddedRefs(root: unknown, entityNames: Map<unknown, string>): WireValue[] {
  const refs: WireValue[] = [];
  const seen = new Set<unknown>();

  function walk(value: unknown): void {
    if (value === null || value === undefined || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);

    if (isAttrRefLike(value)) {
      const entity = value.getLogicalName();
      if (entity) refs.push({ __attrRef: { entity, attribute: value.attribute } });
      return;
    }
    if ("entityType" in value) {
      const name = entityNames.get(value);
      if (name) {
        refs.push({ __entityRef: { entity: name } });
        return;
      }
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    for (const val of Object.values(value as Record<string, unknown>)) walk(val);
  }

  walk(root);
  return refs;
}

/** Encode one value found in an entity's props/attributes/extra-field tree — mirrors `serializer-walker.ts`'s `walkValue` dispatch, targeting the wire format instead of a lexicon format. */
function encodeValue(value: unknown, entityNames: Map<unknown, string>): WireValue {
  if (value === null || value === undefined) return null;

  if (isAttrRefLike(value)) {
    const entity = value.getLogicalName();
    if (!entity) {
      throw new Error(`encodeEntitySet: AttrRef for attribute "${value.attribute}" has no logical name — was resolveAttrRefs run before encoding?`);
    }
    return { __attrRef: { entity, attribute: value.attribute } };
  }

  if (typeof value === "object" && INTRINSIC_MARKER in value) {
    const intrinsic = value as Intrinsic & { toYAML?: () => unknown };
    const toJSONResult = typeof intrinsic.toJSON === "function" ? intrinsic.toJSON() : null;
    const wire: { value: WireValue; yaml?: WireValue; refs: WireValue[] } = {
      value: encodeValue(toJSONResult, entityNames),
      refs: collectEmbeddedRefs(value, entityNames),
    };
    if (typeof intrinsic.toYAML === "function") {
      wire.yaml = encodeValue(intrinsic.toYAML(), entityNames);
    }
    return { __intrinsic: wire };
  }

  if (typeof value === "object" && "entityType" in value) {
    const decl = value as Declarable;
    const name = entityNames.get(decl);
    if (name) {
      // A tracked, top-level entity referenced by identity (e.g. `DependsOn:
      // [otherResource]`).
      return { __entityRef: { entity: name } };
    }
    // Untracked — either genuinely property-kind (never independently named
    // to begin with), or a resource-kind Declarable embedded as a bare
    // nested VALUE that never became its own top-level entity (e.g. Helm's
    // `Helm::Test`/`Helm::Hook` wrap a `new Pod({...})` as their `resource`
    // field, and a Helm chart's own k8s resources — `new Container(...)`,
    // `new PersistentVolumeClaim(...)` inside a `StatefulSet`'s props — are
    // likewise embedded values, never independent entities). Neither case
    // has (or can have) a resolvable logical name: no lexicon serializer's
    // generic dispatch (`serializer-walker.ts`'s `walkValue`) is what reads
    // such a value in practice — every one that touches it reaches straight
    // into its `.props` (see `Helm::Test`'s handling in
    // `lexicons/helm/src/serializer.ts`, which extracts `resource.props`
    // directly rather than walking `resource` as a Declarable reference).
    // Inline exactly that, discarding the unresolvable (and, in every corpus
    // entry today, unread) identity layer.
    const props = "props" in decl ? (decl as unknown as { props?: unknown }).props : undefined;
    return { __property: { lexicon: decl.lexicon, entityType: decl.entityType, props: props !== undefined ? encodeValue(props, entityNames) : undefined } };
  }

  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : encodeValue(item, entityNames)));
  }

  if (typeof value === "object") {
    const result: Record<string, WireValue> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (val === undefined) continue;
      result[key] = encodeValue(val, entityNames);
    }
    return result;
  }

  return value as WireValue;
}

function encodeDeclarable(entity: Declarable, entityNames: Map<unknown, string>): Omit<WireDeclarableEntity, "form" | "name"> {
  const wire: Omit<WireDeclarableEntity, "form" | "name"> = { lexicon: entity.lexicon, entityType: entity.entityType, markers: [] };
  if (entity.kind !== undefined) wire.kind = entity.kind;

  if ("props" in entity && (entity as unknown as { props?: unknown }).props !== undefined) {
    wire.props = encodeValue((entity as unknown as { props: unknown }).props, entityNames);
  }
  if ("attributes" in entity && (entity as unknown as { attributes?: unknown }).attributes !== undefined) {
    wire.attributes = encodeValue((entity as unknown as { attributes: unknown }).attributes, entityNames);
  }

  const markers: string[] = [];
  for (const sym of Object.getOwnPropertySymbols(entity)) {
    if (sym.description && (entity as unknown as Record<symbol, unknown>)[sym] === true) {
      markers.push(sym.description);
    }
  }
  wire.markers = markers;

  const extra: Record<string, WireValue> = {};
  for (const key of Object.keys(entity)) {
    if (CORE_FIELD_NAMES.has(key)) continue;
    const val = (entity as unknown as Record<string, unknown>)[key];
    if (val === undefined) continue;
    extra[key] = encodeValue(val, entityNames);
  }
  if (Object.keys(extra).length > 0) wire.extra = extra;

  return wire;
}

/**
 * Encode a discovered, named, ref-resolved entities map into pure JSON.
 *
 * @throws if any entity is a `ChildProjectInstance` (`nestedStack()`) — its
 *   `outputs` field is a lazy `Proxy`, not representable as data. No corpus
 *   entry uses it today (chant#1045 Phase 1).
 */
export function encodeEntitySet(entities: Map<string, Declarable>): EntitySetWire {
  const entityNames = new Map<unknown, string>();
  for (const [name, entity] of entities) entityNames.set(entity, name);

  const wireEntities: WireEntity[] = [];
  for (const [name, entity] of entities) {
    if (isChildProject(entity)) {
      throw new Error(
        `encodeEntitySet: entity "${name}" is a child project (nestedStack()) — not yet supported by the JSON entity boundary (chant#1045 Phase 1)`,
      );
    }
    if (isLexiconOutput(entity)) {
      const ref = lexiconOutputRef(entity, entityNames);
      wireEntities.push({ form: "lexiconOutput", name, outputName: entity.outputName, ref: encodeValue(ref, entityNames) });
      continue;
    }
    wireEntities.push({ form: "declarable", name, ...encodeDeclarable(entity, entityNames) });
  }

  return { entities: wireEntities };
}

// ─────────────────────────────────────────────────────────────────────────
// Decode: JSON-safe wire data → live entities map.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Decode one wire value, resolving `__attrRef`/`__entityRef`/`__property`/
 * `__intrinsic` markers against `registry` (name → already-reconstructed live
 * object).
 *
 * Reads via an explicit cast (`asRecord`) rather than relying on TS's `in`-
 * narrowing across the {@link WireValue} union: the union's catch-all plain-
 * object member (`{ [key: string]: WireValue }`) structurally overlaps every
 * marker shape too (an index signature accepts any key), so narrowing alone
 * can't tell TS which shape's fields are actually present at runtime.
 */
function decodeValue(wire: WireValue, registry: Map<string, unknown>): unknown {
  if (wire === null || typeof wire !== "object") return wire;

  if (Array.isArray(wire)) {
    return wire.map((item) => decodeValue(item, registry));
  }

  const asRecord = wire as unknown as Record<string, unknown>;

  if ("__attrRef" in asRecord) {
    const { entity, attribute } = asRecord.__attrRef as { entity: string; attribute: string };
    const parent = registry.get(entity);
    if (!parent) throw new Error(`decodeEntitySet: __attrRef refers to unknown entity "${entity}"`);
    const ref = new AttrRef(parent as object, attribute);
    ref._setLogicalName(entity);
    return ref;
  }

  if ("__entityRef" in asRecord) {
    const { entity } = asRecord.__entityRef as { entity: string };
    const target = registry.get(entity);
    if (!target) throw new Error(`decodeEntitySet: __entityRef refers to unknown entity "${entity}"`);
    return target;
  }

  if ("__property" in asRecord) {
    const { lexicon, entityType, props } = asRecord.__property as { lexicon: string; entityType: string; props?: WireValue };
    const obj: Record<string | symbol, unknown> = {};
    Object.defineProperty(obj, DECLARABLE_MARKER, { value: true, enumerable: false });
    Object.defineProperty(obj, "lexicon", { value: lexicon, enumerable: false, configurable: true });
    Object.defineProperty(obj, "entityType", { value: entityType, enumerable: false, configurable: true });
    Object.defineProperty(obj, "kind", { value: "property", enumerable: false, configurable: true });
    if (props !== undefined) {
      Object.defineProperty(obj, "props", { value: decodeValue(props, registry), enumerable: false, configurable: true });
    }
    return obj;
  }

  if ("__intrinsic" in asRecord) {
    const intrinsicWire = asRecord.__intrinsic as { value: WireValue; yaml?: WireValue; refs: WireValue[] };
    const decodedValue = decodeValue(intrinsicWire.value, registry);
    const decodedRefs = intrinsicWire.refs.map((ref) => decodeValue(ref, registry));
    const wrapper: Record<string, unknown> = {
      [INTRINSIC_MARKER]: true,
      __chantWireRefs: decodedRefs,
      toJSON(): unknown {
        return decodedValue;
      },
    };
    // Only present when the original intrinsic ALSO implemented `toYAML()`
    // (see {@link WireValue}'s doc) — gitlab/github's serializers duck-type
    // this method, so it must exist on the reconstructed wrapper only when
    // it existed on the original, not unconditionally.
    if ("yaml" in intrinsicWire) {
      const decodedYaml = decodeValue(intrinsicWire.yaml as WireValue, registry);
      wrapper.toYAML = (): unknown => decodedYaml;
    }
    return wrapper;
  }

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(asRecord)) {
    result[key] = decodeValue(val as WireValue, registry);
  }
  return result;
}

function decodeDeclarableShell(wire: WireDeclarableEntity): Declarable {
  const obj: Record<string | symbol, unknown> = {};
  for (const marker of wire.markers) {
    Object.defineProperty(obj, Symbol.for(marker), { value: true, enumerable: false, configurable: true });
  }
  // DECLARABLE_MARKER is always one of `wire.markers` (every Declarable carries
  // it), but define it defensively in case an entity somehow didn't round-trip
  // it, so a decoded entity always satisfies `isDeclarable()`.
  if (!(DECLARABLE_MARKER in obj)) {
    Object.defineProperty(obj, DECLARABLE_MARKER, { value: true, enumerable: false });
  }
  Object.defineProperty(obj, "lexicon", { value: wire.lexicon, enumerable: false, configurable: true });
  Object.defineProperty(obj, "entityType", { value: wire.entityType, enumerable: false, configurable: true });
  if (wire.kind !== undefined) {
    Object.defineProperty(obj, "kind", { value: wire.kind, enumerable: false, configurable: true });
  }
  return obj as unknown as Declarable;
}

/**
 * Decode a JSON entity set (see {@link encodeEntitySet}) back into a live
 * `Map<string, Declarable>`, functionally indistinguishable from what
 * `discover()` would have produced in-process.
 */
export function decodeEntitySet(wire: EntitySetWire): Map<string, Declarable> {
  const registry = new Map<string, unknown>();

  // Pass 1: create every declarable's shell up front, so pass 2 can resolve a
  // forward (or circular, e.g. mutual DependsOn) reference to any entity by
  // name regardless of declaration order — exactly like the live WeakRef graph
  // discover() produces tolerates today.
  for (const entry of wire.entities) {
    if (entry.form === "declarable") {
      registry.set(entry.name, decodeDeclarableShell(entry));
    }
  }

  const result = new Map<string, Declarable>();
  for (const entry of wire.entities) {
    if (entry.form === "declarable") {
      const obj = registry.get(entry.name) as Record<string | symbol, unknown>;
      if (entry.props !== undefined) {
        Object.defineProperty(obj, "props", { value: decodeValue(entry.props, registry), enumerable: false, configurable: true });
      }
      if (entry.attributes !== undefined) {
        Object.defineProperty(obj, "attributes", { value: decodeValue(entry.attributes, registry), enumerable: false, configurable: true });
      }
      for (const [key, val] of Object.entries(entry.extra ?? {})) {
        obj[key] = decodeValue(val, registry);
      }
      result.set(entry.name, obj as unknown as Declarable);
      continue;
    }

    // LexiconOutput — constructed via its real constructor from the decoded
    // ref, so it derives sourceLexicon/_sourceParent/sourceAttribute exactly
    // the way constructing it from a live AttrRef/Intrinsic would.
    const ref = decodeValue(entry.ref, registry) as AttrRef | Intrinsic;
    const output = new LexiconOutput(ref, entry.outputName);
    registry.set(entry.name, output);
    result.set(entry.name, output as unknown as Declarable);
  }

  return result;
}
