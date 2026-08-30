/**
 * Build provenance: where a declared entity came from in the TypeScript source.
 *
 * Stamped during discovery as a non-enumerable, symbol-keyed side channel on the
 * entity object, so it never serializes into the emitted YAML/JSON — it is build
 * metadata, not declared configuration. Read it back with {@link getProvenance}.
 *
 * Entity-level provenance (which file declared it, and which composite expanded
 * it) answers "where did this resource come from?", which is the question an
 * agent asks before changing it. {@link PathOrigin} (chant #1443) answers the
 * follow-up — "what set THIS field" — for the paths a build can attribute
 * without guessing. Neither is a YAML-line source map.
 *
 * {@link BuildParamProvenance} (chant #1064) is the other half: not "where did
 * this ENTITY come from" but "what INPUTS was this whole BUILD invoked with" —
 * the question ambient `process.env` reads used to answer invisibly. See
 * ../build-params.ts for declaration/resolution and ../build.ts's
 * `BuildResult.buildParams` for where a build surfaces it.
 */

const PROVENANCE = Symbol.for("chant.provenance");

export interface EntityProvenance {
  /** Absolute path of the source file that declared (or exported) the entity. */
  sourceFile?: string;
  /** The composite (type) that expanded this entity, when it came from one. */
  composite?: string;
  /**
   * The composite *instance* this entity belongs to — the export name of the
   * top-level composite, shared by every member it expanded to. Distinguishes
   * two instances of the same composite type, which `composite` cannot. Used to
   * collapse a composite to a single node at coarse diagram detail levels (#494).
   */
  compositeInstance?: string;
  /**
   * Per-path origins within the entity's `props` (chant #1443). Read with
   * {@link originOfPath}, which does the prefix resolution these keys are
   * written for.
   *
   * Keys are dotted property paths only — `spec.template.spec.containers` —
   * with `""` for the whole entity. They never carry an array segment, because
   * a producing mechanism attributes a whole array at once: the coarsest path
   * it actually determines is the honest one to record, and a positional key
   * would go stale the moment an element moved.
   *
   * Query paths come from #1441's diff addressing and may carry `[#key]` for an
   * element of an associative list or `[n]` for a positional one. Resolution is
   * longest segment-boundary prefix, so `spec.containers[#app].image` finds a
   * key recorded at `spec.containers`, and a key recorded at
   * `spec.containers.image` never matches it. The two grammars agree without
   * the recorder needing the lexicon's ordering hook, which it has no access to.
   *
   * Absent means this build could not record path origins, not that nothing
   * governs the entity's fields — the run path executes modules and has no
   * expression to inspect, and a sandboxed child's provenance does not survive
   * the wire (`discovery/entity-wire-codec.ts` drops build metadata).
   */
  paths?: Record<string, PathOrigin>;
}

/**
 * What produced one path inside an entity's props.
 *
 * - `authored` — written in the source file that declared the entity.
 * - `composite` — the entity was expanded by a composite, or the path was
 *   supplied by `propagate()`'s shared props at the instance.
 * - `build-param` — the build parameters the authored expression for this path
 *   *reads*, which is a syntactic dependency, not a value taint. For
 *   `replicas: params.tier === "prod" ? 5 : 1` a taint says the value came from
 *   the literal `5`, which is true and useless; the dependency says the field
 *   is governed by `tier`, which is what an editor needs to know. Under-reports
 *   (a shape the collector does not follow drops a dependency) and never
 *   over-reports a parameter the expression does not mention.
 */
export type PathOrigin =
  | { kind: "authored" }
  | { kind: "composite"; composite: string; instance: string }
  | { kind: "build-param"; params: string[] };

/** True when `prefix` addresses `path` or an ancestor of it, on a segment boundary. */
function isPathPrefix(prefix: string, path: string): boolean {
  if (prefix === "") return true;
  if (!path.startsWith(prefix)) return false;
  if (path.length === prefix.length) return true;
  const next = path[prefix.length];
  return next === "." || next === "[";
}

/**
 * Merge provenance onto an entity. Non-enumerable so it is invisible to
 * serializers and spreads. Existing fields win (`??=`), so the first/most
 * specific writer — the innermost composite, the declaring file — is kept.
 */
export function setProvenance(entity: object, prov: EntityProvenance): void {
  if (!Object.isExtensible(entity)) return;
  const existing = (entity as Record<symbol, unknown>)[PROVENANCE] as EntityProvenance | undefined;
  if (existing) {
    existing.sourceFile ??= prov.sourceFile;
    existing.composite ??= prov.composite;
    existing.compositeInstance ??= prov.compositeInstance;
    if (prov.paths) {
      existing.paths ??= {};
      for (const [path, origin] of Object.entries(prov.paths)) {
        existing.paths[path] ??= origin;
      }
    }
    return;
  }
  Object.defineProperty(entity, PROVENANCE, {
    value: { ...prov, ...(prov.paths ? { paths: { ...prov.paths } } : {}) },
    enumerable: false,
    writable: true,
    configurable: true,
  });
}

/** Read an entity's build provenance, if any was stamped. */
export function getProvenance(entity: object): EntityProvenance | undefined {
  return (entity as Record<symbol, unknown>)[PROVENANCE] as EntityProvenance | undefined;
}

/**
 * Record one path's origin, first writer wins — the same rule
 * {@link setProvenance} applies to entity-level fields, and for the same
 * reason: expansion runs innermost-composite-first, so the earliest writer is
 * the most specific one.
 */
export function setPathProvenance(entity: object, path: string, origin: PathOrigin): void {
  setProvenance(entity, { paths: { [path]: origin } });
}

/**
 * An entity's recorded path origins in sorted key order, or `undefined` when
 * none were recorded. Sorted because a build's outputs are compared byte for
 * byte and object key order is not something insertion should decide.
 */
export function getPathProvenance(entity: object): Record<string, PathOrigin> | undefined {
  const paths = getProvenance(entity)?.paths;
  if (!paths) return undefined;
  const keys = Object.keys(paths).sort();
  if (keys.length === 0) return undefined;
  const out: Record<string, PathOrigin> = {};
  for (const key of keys) out[key] = paths[key];
  return out;
}

/**
 * The origin governing `path` — the longest recorded key that addresses it or
 * one of its ancestors. See {@link PROVENANCE_PATH_GRAMMAR}.
 */
export function originOfPath(
  paths: Readonly<Record<string, PathOrigin>> | undefined,
  path: string,
): PathOrigin | undefined {
  if (!paths) return undefined;
  let best: string | undefined;
  for (const key of Object.keys(paths)) {
    if (!isPathPrefix(key, path)) continue;
    if (best === undefined || key.length > best.length) best = key;
  }
  return best === undefined ? undefined : paths[best];
}

/** One-line rendering of an origin, for diff output. */
export function describePathOrigin(origin: PathOrigin): string {
  switch (origin.kind) {
    case "authored":
      return "authored";
    case "composite":
      return `composite ${origin.composite} (${origin.instance})`;
    case "build-param":
      return `param ${origin.params.join(", ")}`;
  }
}

/**
 * One resolved build-time parameter (chant #1064, see ../build-params.ts): its
 * final value and which source won it, so a build's parameter inputs are
 * auditable rather than inferred. `source` records precedence, most to least
 * specific: an explicit `--param`/`--params-file` value beats a declared `env`
 * mapping, which beats `chant.config.ts`'s `default`.
 */
export interface BuildParamProvenance {
  /** The declared parameter name (a key of `chant.config.ts`'s `buildParams`). */
  name: string;
  /** The resolved, type-coerced value actually bound to `params.<name>` for this build. */
  value: string | number | boolean;
  /** Which input supplied the value. */
  source: "cli" | "params-file" | "env" | "default";
}
