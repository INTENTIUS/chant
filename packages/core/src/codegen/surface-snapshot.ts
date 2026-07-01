/**
 * Lexicon API surface snapshot and diff.
 *
 * Extracts a stable, serializable representation of a lexicon's public API
 * surface from the generated lexicon JSON. Diffs a fresh snapshot against a
 * committed baseline and classifies each change as additive or breaking.
 *
 * The surface is derived from the lexicon registry JSON that every lexicon's
 * `generate` step writes to `src/generated/<name>.json`. Resource and
 * property-type names, together with their structural metadata (attrs, props,
 * kind), form the baseline. The generated .d.ts is not used for diffing
 * because: (a) it is not self-describing without parsing TypeScript, and
 * (b) the registry JSON already encodes everything a consumer needs.
 */

// ── Surface types ───────────────────────────────────────────────────

/**
 * A single entry in the surface snapshot.
 * "resource" entries carry attrs and props; "property" entries are lightweight.
 */
export interface SurfaceEntry {
  kind: "resource" | "property";
  /** The cloud-provider resource type string (e.g. "AWS::S3::Bucket"). */
  resourceType: string;
  /** Readonly attribute names (resource entries only). */
  attrs?: string[];
  /**
   * Property names with their required flag. Stored as
   * `name:required` strings (e.g. "BucketName:false", "Tags:false").
   * Sorting is stable so the snapshot is deterministic.
   */
  props?: string[];
  /** Names that are create-only / immutable after creation. */
  createOnly?: string[];
  /**
   * Whether the resource supports tagging.
   * Present when known; absent means not known or not applicable.
   */
  taggable?: boolean;
}

/**
 * The complete surface snapshot for one lexicon.
 */
export interface SurfaceSnapshot {
  /**
   * Schema version for forward-compatibility. Bump when the shape changes
   * in a way that makes old snapshots unreadable by newer tooling.
   */
  schemaVersion: 1;
  /** When this snapshot was generated (ISO 8601 UTC). */
  generatedAt: string;
  /**
   * Per-entry map keyed by the TS export name (e.g. "Bucket",
   * "Bucket_Tag"). Sorted alphabetically for stable diffs.
   */
  entries: Record<string, SurfaceEntry>;
}

// ── Delta types ─────────────────────────────────────────────────────

export type ChangeSeverity = "additive" | "breaking" | "none";

export interface AddedEntry {
  name: string;
  entry: SurfaceEntry;
}

export interface RemovedEntry {
  name: string;
  entry: SurfaceEntry;
}

export interface ChangedEntry {
  name: string;
  /** New resourceType (breaking). */
  resourceTypeChanged?: { before: string; after: string };
  /** kind changed from resource to property or vice-versa (breaking). */
  kindChanged?: { before: string; after: string };
  /** Props that were removed (breaking). */
  removedProps?: string[];
  /** Props that switched from optional to required (breaking). */
  nowRequired?: string[];
  /** Attrs that were removed (breaking). */
  removedAttrs?: string[];
  /** Props that were newly added. */
  addedProps?: string[];
  /** Props that switched from required to optional (additive). */
  nowOptional?: string[];
  /** Attrs that were newly added. */
  addedAttrs?: string[];
  /** createOnly set changed. */
  createOnlyChanged?: { before: string[]; after: string[] };
  /** taggable flag changed. */
  taggableChanged?: { before?: boolean; after?: boolean };
}

export interface SurfaceDelta {
  added: AddedEntry[];
  changed: ChangedEntry[];
  removed: RemovedEntry[];
  /**
   * Rolled-up severity. "none" means no surface changes at all.
   * "additive" means only new resources / new optional props / new attrs.
   * "breaking" means any removal or change that could break existing consumers.
   */
  severity: ChangeSeverity;
}

// ── LexiconEntry ── raw shape from lexicon JSON ──────────────────────

interface LexiconEntry {
  kind?: "resource" | "property";
  resourceType?: string;
  attrs?: Record<string, string>;
  createOnly?: string[];
  tagging?: { taggable?: boolean };
}

// ── Extraction ───────────────────────────────────────────────────────

/**
 * Extract a surface snapshot from the lexicon JSON and the generated index.d.ts.
 *
 * The lexicon JSON contains the resource/property registry (names, kinds,
 * attrs, createOnly, tagging). The .d.ts provides per-prop names and their
 * required flags for resource constructor shapes.
 *
 * @param lexiconJSON   Contents of `src/generated/<name>.json`
 * @param typesDTS      Contents of `src/generated/index.d.ts`
 */
export function extractSurface(lexiconJSON: string, typesDTS: string): SurfaceSnapshot {
  const registry = JSON.parse(lexiconJSON) as Record<string, LexiconEntry>;

  // Build prop map from .d.ts
  const propsMap = extractPropsFromDts(typesDTS);

  const entries: Record<string, SurfaceEntry> = {};

  for (const [name, raw] of Object.entries(registry)) {
    const kind = raw.kind ?? "property";
    const resourceType = raw.resourceType ?? "";

    const entry: SurfaceEntry = { kind, resourceType };

    if (kind === "resource") {
      const attrs = raw.attrs ? Object.keys(raw.attrs).sort() : [];
      if (attrs.length > 0) entry.attrs = attrs;

      // Props from .d.ts
      const props = propsMap.get(name);
      if (props && props.length > 0) entry.props = props;

      const createOnly = raw.createOnly ? [...raw.createOnly].sort() : [];
      if (createOnly.length > 0) entry.createOnly = createOnly;

      if (raw.tagging?.taggable !== undefined) {
        entry.taggable = raw.tagging.taggable;
      }
    }

    entries[name] = entry;
  }

  // Sort keys for stable output
  const sorted: Record<string, SurfaceEntry> = {};
  for (const key of Object.keys(entries).sort()) {
    sorted[key] = entries[key];
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    entries: sorted,
  };
}

/**
 * Lightweight extractor: pull constructor prop names and required flags
 * from a `.d.ts` string.
 *
 * Handles the pattern generated by writeConstructor:
 * ```
 * export declare class Bucket {
 *   constructor(props: {
 *     BucketName?: string;
 *     Tags: Bucket_Tag[];
 *   }, attributes?: CFResourceAttributes);
 * }
 * ```
 *
 * Returns a Map<className, ["PropName:required", ...]>
 * where each entry is sorted alphabetically.
 */
export function extractPropsFromDts(dts: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const lines = dts.split("\n");

  let className: string | null = null;
  let inConstructorProps = false;
  let braceDepth = 0;
  const currentProps: string[] = [];
  // Track class-body brace depth separately
  let classBraceDepth = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    // Start of a class
    const classMatch = /^export declare class (\w+)/.exec(trimmed);
    if (classMatch) {
      className = classMatch[1];
      inConstructorProps = false;
      braceDepth = 0;
      classBraceDepth = 1; // opening { is on this line
      currentProps.length = 0;
      continue;
    }

    if (!className) continue;

    // Track class-body braces when not in constructor props
    if (!inConstructorProps) {
      // End of class block (classBraceDepth back to 0)
      let delta = 0;
      for (const ch of trimmed) {
        if (ch === "{") delta++;
        if (ch === "}") delta--;
      }
      classBraceDepth += delta;

      if (classBraceDepth <= 0) {
        // Leaving class body — record and reset
        if (currentProps.length > 0) {
          map.set(className, [...currentProps].sort());
          currentProps.length = 0;
        }
        className = null;
        classBraceDepth = 0;
        continue;
      }

      // Constructor start
      if (trimmed.startsWith("constructor(props: {")) {
        inConstructorProps = true;
        braceDepth = 1;
        currentProps.length = 0;
        continue;
      }
      // Constructor with empty props object on one line (no sub-braces needed)
      // constructor(props: Record<string, unknown>) — skip
      continue;
    }

    // Inside constructor props block

    // Track brace depth
    let delta = 0;
    for (const ch of trimmed) {
      if (ch === "{") delta++;
      if (ch === "}") delta--;
    }
    braceDepth += delta;

    // End of constructor props block
    if (braceDepth <= 0) {
      inConstructorProps = false;
      braceDepth = 0;
      // Record the props collected so far
      if (!map.has(className) && currentProps.length > 0) {
        map.set(className, [...currentProps].sort());
        currentProps.length = 0;
      }
      continue;
    }

    // Skip comments
    if (trimmed.startsWith("/**") || trimmed.startsWith("*") || trimmed.startsWith("//")) continue;

    // Match a prop: `PropName?: type;` or `PropName: type;`
    // Prop names may be quoted for non-identifier keys
    const propMatch = /^(?:"([^"]+)"|(\w+))(\??):/.exec(trimmed);
    if (propMatch) {
      const propName = propMatch[1] ?? propMatch[2];
      const optional = propMatch[3] === "?";
      // Encode as "name:required" — "true" means required
      currentProps.push(`${propName}:${!optional}`);
    }
  }

  return map;
}

// ── Diff ─────────────────────────────────────────────────────────────

/**
 * Diff a fresh snapshot against a committed baseline.
 *
 * Classification rules:
 * - Added entry → additive
 * - Removed entry → breaking
 * - Changed entry:
 *   - resourceType changed → breaking
 *   - kind changed → breaking
 *   - prop removed → breaking
 *   - prop now required (was optional) → breaking
 *   - attr removed → breaking
 *   - createOnly changed → breaking (changes immutability contract)
 *   - taggable: false→undefined or true→false → breaking
 *   - prop added (optional) → additive
 *   - prop now optional (was required) → additive
 *   - attr added → additive
 *   - taggable: false→true or undefined→true → additive
 */
export function diffSurface(baseline: SurfaceSnapshot, fresh: SurfaceSnapshot): SurfaceDelta {
  const added: AddedEntry[] = [];
  const changed: ChangedEntry[] = [];
  const removed: RemovedEntry[] = [];

  const baseNames = new Set(Object.keys(baseline.entries));
  const freshNames = new Set(Object.keys(fresh.entries));

  // Added
  for (const name of freshNames) {
    if (!baseNames.has(name)) {
      added.push({ name, entry: fresh.entries[name] });
    }
  }

  // Removed
  for (const name of baseNames) {
    if (!freshNames.has(name)) {
      removed.push({ name, entry: baseline.entries[name] });
    }
  }

  // Changed
  for (const name of baseNames) {
    if (!freshNames.has(name)) continue;

    const before = baseline.entries[name];
    const after = fresh.entries[name];

    const change: ChangedEntry = { name };
    let hasChange = false;

    if (before.resourceType !== after.resourceType) {
      change.resourceTypeChanged = { before: before.resourceType, after: after.resourceType };
      hasChange = true;
    }

    if (before.kind !== after.kind) {
      change.kindChanged = { before: before.kind, after: after.kind };
      hasChange = true;
    }

    // Props diff (only meaningful for resource entries)
    const beforeProps = new Map(
      (before.props ?? []).map((p) => {
        const [nm, req] = splitProp(p);
        return [nm, req === "true"];
      }),
    );
    const afterProps = new Map(
      (after.props ?? []).map((p) => {
        const [nm, req] = splitProp(p);
        return [nm, req === "true"];
      }),
    );

    const removedProps = [...beforeProps.keys()].filter((k) => !afterProps.has(k));
    const addedProps = [...afterProps.keys()].filter((k) => !beforeProps.has(k));
    const nowRequired = [...beforeProps.keys()].filter(
      (k) => afterProps.has(k) && !beforeProps.get(k) && afterProps.get(k),
    );
    const nowOptional = [...beforeProps.keys()].filter(
      (k) => afterProps.has(k) && beforeProps.get(k) && !afterProps.get(k),
    );

    if (removedProps.length > 0) { change.removedProps = removedProps.sort(); hasChange = true; }
    if (addedProps.length > 0) { change.addedProps = addedProps.sort(); hasChange = true; }
    if (nowRequired.length > 0) { change.nowRequired = nowRequired.sort(); hasChange = true; }
    if (nowOptional.length > 0) { change.nowOptional = nowOptional.sort(); hasChange = true; }

    // Attrs diff
    const beforeAttrs = new Set(before.attrs ?? []);
    const afterAttrs = new Set(after.attrs ?? []);
    const removedAttrs = [...beforeAttrs].filter((a) => !afterAttrs.has(a));
    const addedAttrs = [...afterAttrs].filter((a) => !beforeAttrs.has(a));
    if (removedAttrs.length > 0) { change.removedAttrs = removedAttrs.sort(); hasChange = true; }
    if (addedAttrs.length > 0) { change.addedAttrs = addedAttrs.sort(); hasChange = true; }

    // createOnly diff
    const beforeCO = JSON.stringify((before.createOnly ?? []).sort());
    const afterCO = JSON.stringify((after.createOnly ?? []).sort());
    if (beforeCO !== afterCO) {
      change.createOnlyChanged = {
        before: before.createOnly ?? [],
        after: after.createOnly ?? [],
      };
      hasChange = true;
    }

    // taggable diff
    if (before.taggable !== after.taggable) {
      change.taggableChanged = { before: before.taggable, after: after.taggable };
      hasChange = true;
    }

    if (hasChange) changed.push(change);
  }

  // Severity
  let severity: ChangeSeverity = "none";

  if (added.length > 0) {
    severity = "additive";
  }

  // Additive-only changes in the changed[] set
  const hasAdditiveChanges = changed.some((c) =>
    (c.addedProps?.length ?? 0) > 0 ||
    (c.nowOptional?.length ?? 0) > 0 ||
    (c.addedAttrs?.length ?? 0) > 0 ||
    // gaining tagging is additive
    (c.taggableChanged !== undefined && c.taggableChanged.after === true && c.taggableChanged.before !== true),
  );

  if (hasAdditiveChanges && severity === "none") {
    severity = "additive";
  }

  const hasBreaking =
    removed.length > 0 ||
    changed.some(
      (c) =>
        c.resourceTypeChanged !== undefined ||
        c.kindChanged !== undefined ||
        (c.removedProps?.length ?? 0) > 0 ||
        (c.nowRequired?.length ?? 0) > 0 ||
        (c.removedAttrs?.length ?? 0) > 0 ||
        (c.createOnlyChanged !== undefined) ||
        // losing taggable is breaking
        (c.taggableChanged !== undefined && c.taggableChanged.before === true && c.taggableChanged.after !== true),
    );

  if (hasBreaking) severity = "breaking";

  return { added, changed, removed, severity };
}

// ── Serialization ────────────────────────────────────────────────────

/**
 * Serialize a snapshot to stable JSON. Suitable for writing to
 * `surface.snapshot.json` at the lexicon root.
 */
export function serializeSnapshot(snapshot: SurfaceSnapshot): string {
  return JSON.stringify(snapshot, null, 2) + "\n";
}

/**
 * Parse a snapshot from JSON.
 */
export function parseSnapshot(json: string): SurfaceSnapshot {
  return JSON.parse(json) as SurfaceSnapshot;
}

// ── Human-readable output ────────────────────────────────────────────

/**
 * Render a surface delta as human-readable text.
 */
export function formatDelta(delta: SurfaceDelta): string {
  const lines: string[] = [];

  if (delta.added.length > 0) {
    lines.push(`Added (${delta.added.length}):`);
    for (const e of delta.added) {
      lines.push(`  + ${e.name} [${e.entry.kind}] (${e.entry.resourceType})`);
    }
  }

  if (delta.removed.length > 0) {
    lines.push(`Removed (${delta.removed.length}):`);
    for (const e of delta.removed) {
      lines.push(`  - ${e.name} [${e.entry.kind}] (${e.entry.resourceType})`);
    }
  }

  if (delta.changed.length > 0) {
    lines.push(`Changed (${delta.changed.length}):`);
    for (const c of delta.changed) {
      lines.push(`  ~ ${c.name}`);
      if (c.resourceTypeChanged) {
        lines.push(`      resourceType: ${c.resourceTypeChanged.before} -> ${c.resourceTypeChanged.after}`);
      }
      if (c.kindChanged) {
        lines.push(`      kind: ${c.kindChanged.before} -> ${c.kindChanged.after}`);
      }
      if (c.removedProps?.length) {
        lines.push(`      removed props: ${c.removedProps.join(", ")}`);
      }
      if (c.nowRequired?.length) {
        lines.push(`      now required: ${c.nowRequired.join(", ")}`);
      }
      if (c.addedProps?.length) {
        lines.push(`      added props: ${c.addedProps.join(", ")}`);
      }
      if (c.nowOptional?.length) {
        lines.push(`      now optional: ${c.nowOptional.join(", ")}`);
      }
      if (c.removedAttrs?.length) {
        lines.push(`      removed attrs: ${c.removedAttrs.join(", ")}`);
      }
      if (c.addedAttrs?.length) {
        lines.push(`      added attrs: ${c.addedAttrs.join(", ")}`);
      }
      if (c.createOnlyChanged) {
        const before = c.createOnlyChanged.before.join(", ") || "(none)";
        const after = c.createOnlyChanged.after.join(", ") || "(none)";
        lines.push(`      createOnly: [${before}] -> [${after}]`);
      }
      if (c.taggableChanged) {
        lines.push(`      taggable: ${c.taggableChanged.before ?? "(unset)"} -> ${c.taggableChanged.after ?? "(unset)"}`);
      }
    }
  }

  if (lines.length === 0) {
    lines.push("No surface changes.");
  }

  lines.push("");
  lines.push(`Severity: ${delta.severity}`);

  return lines.join("\n");
}

// ── Helpers ──────────────────────────────────────────────────────────

function splitProp(encoded: string): [string, string] {
  const idx = encoded.lastIndexOf(":");
  return [encoded.slice(0, idx), encoded.slice(idx + 1)];
}
