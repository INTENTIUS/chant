/**
 * Backfilled properties (chant #3953).
 *
 * The Registry spec is pinned by content (src/spec/pin.ts), so a property AWS
 * adds after the pin was accepted does not reach the generated types until the
 * pin moves. Moving it is a reviewed, whole-spec decision: the 2026-08-05 pin
 * against the October upstream is 185 resource types apart. When one property
 * is needed before that, it goes here instead of being cast past the types.
 *
 * Each entry names a top-level property and the schema fragment to add for it,
 * copied from the live Registry schema. It is merged into the raw schema before
 * parsing, so the property reaches the `.d.ts` and the lexicon registry by the
 * same path a spec property does. The overlay has no way to mark a property
 * create-only, so it only suits properties that are updatable in place.
 *
 * Precedence follows the enum overlay (#1497): where the spec already declares
 * the property, the spec wins and the entry is reported as redundant, so a pin
 * bump surfaces the entries it retires.
 */

import overlayDocument from "./property-overlay.json" with { type: "json" };

/** One backfilled property. */
export interface PropertyOverlayEntry {
  /** CloudFormation type name, e.g. `AWS::BedrockAgentCore::Runtime`. */
  type: string;
  /** Top-level property name, added under `/properties`. */
  property: string;
  /** The chant issue that asked for it. */
  issue: number;
  /** Where the schema fragment was copied from. */
  source: string;
  /** ISO date the fragment was last read from `source`. */
  reviewed: string;
  /** JSON Schema for the property, as the Registry schema declares it. */
  schema: Record<string, unknown>;
}

/** What happened to one entry during a generation run. */
export interface PropertyOverlayApplication {
  entry: PropertyOverlayEntry;
  /** `applied` added the property; `redundant` found the spec already declares it. */
  outcome: "applied" | "redundant";
}

/** The backfilled entries, in file order. */
export function propertyOverlayEntries(): PropertyOverlayEntry[] {
  return overlayDocument.entries as PropertyOverlayEntry[];
}

/** Entries grouped by CloudFormation type name. */
export function propertyOverlayByType(
  entries: PropertyOverlayEntry[] = propertyOverlayEntries(),
): Map<string, PropertyOverlayEntry[]> {
  const byType = new Map<string, PropertyOverlayEntry[]>();
  for (const entry of entries) {
    const list = byType.get(entry.type);
    if (list) list.push(entry);
    else byType.set(entry.type, [entry]);
  }
  return byType;
}

/** Add the entries for one CloudFormation type to its raw schema bytes. */
export function applyPropertyOverlay(
  data: Buffer | string,
  entries: PropertyOverlayEntry[],
): { data: Buffer | string; applications: PropertyOverlayApplication[] } {
  if (entries.length === 0) return { data, applications: [] };

  const text = typeof data === "string" ? data : data.toString("utf-8");
  const doc = JSON.parse(text) as Record<string, unknown>;
  const properties = (doc.properties ??= {}) as Record<string, unknown>;
  const applications: PropertyOverlayApplication[] = [];
  let changed = false;

  for (const entry of entries) {
    if (entry.property in properties) {
      applications.push({ entry, outcome: "redundant" });
      continue;
    }
    properties[entry.property] = structuredClone(entry.schema);
    changed = true;
    applications.push({ entry, outcome: "applied" });
  }

  if (!changed) return { data, applications };
  const rewritten = JSON.stringify(doc);
  return {
    data: typeof data === "string" ? rewritten : Buffer.from(rewritten),
    applications,
  };
}

/**
 * Fail on an entry whose type the run never saw. Only a run over the real
 * schema zip is strict; a fixture run legitimately lacks most types.
 */
export function assertPropertyOverlayCoverage(
  entries: PropertyOverlayEntry[],
  seenTypes: Set<string>,
  strict: boolean,
): void {
  if (!strict) return;
  const missing = [...new Set(entries.filter((e) => !seenTypes.has(e.type)).map((e) => e.type))];
  if (missing.length === 0) return;
  throw new Error(
    `property overlay names type(s) the spec does not contain: ${missing.sort().join(", ")}. ` +
      `Drop them from src/codegen/property-overlay.json or fix the type name.`,
  );
}

/** One warning line per entry the spec has caught up with. */
export function redundantPropertyOverlayWarnings(
  applications: PropertyOverlayApplication[],
): Array<{ file: string; error: string }> {
  return applications
    .filter((a) => a.outcome === "redundant")
    .map((a) => ({
      file: `${a.entry.type}/properties/${a.entry.property}`,
      error:
        `property overlay entry is redundant: the spec already declares this property, ` +
        `and the spec wins. Retire the entry from src/codegen/property-overlay.json.`,
    }));
}
