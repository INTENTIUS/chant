/**
 * Curated enum overlay (chant #1497).
 *
 * The CloudFormation Registry spec declares `enum` on some properties and not
 * on others, and the split does not follow how often a property is written:
 * `AWS::SageMaker::NotebookInstance.InstanceType` is a union while
 * `AWS::EC2::Instance.InstanceType` is a bare `string`. Where the spec is
 * silent the generated type stops teaching the API, and a wrong value survives
 * `tsc` and `chant build` to fail at deploy.
 *
 * This overlay is a checked-in list of `(CFN type, JSON pointer, values)`
 * entries merged into the raw schema before parsing, so a curated enum reaches
 * the generated `.d.ts` and the lexicon registry by exactly the path a spec
 * enum reaches them. Nothing here is fetched at build time: the values live in
 * `enum-overlay.json` beside this file, each with the source it was read from
 * and the date it was read, so `scripts/refresh-enum-overlay.ts` can diff them
 * later.
 *
 * Precedence: the overlay only fills gaps. An entry whose target already
 * declares `enum` (from the Registry spec or from a cfn-lint patch) leaves the
 * spec alone and reports itself as redundant. Upstream is refreshed on every
 * `generate`, so it is the source that keeps tracking AWS; a hand list allowed
 * to win would rot invisibly and would make the generated type depend on which
 * of two sources happened to be newer. Reporting the overlap instead surfaces
 * the entry for retirement the moment upstream catches up.
 *
 * An entry that matches nothing is an error, not a shrug: a renamed or removed
 * property means the curated values are being applied to a property that no
 * longer exists, and silence there is how an overlay goes stale.
 */

import overlayDocument from "./enum-overlay.json" with { type: "json" };

/** Where an entry's values were read from, and enough detail to read them again. */
export type EnumOverlaySource =
  | {
      kind: "botocore";
      /** Directory under `botocore/data`, e.g. `elbv2`. */
      service: string;
      /** API version directory, e.g. `2015-12-01`. */
      apiVersion: string;
      /** Shape name carrying the `enum`, e.g. `ProtocolEnum`. */
      shape: string;
    }
  | {
      kind: "docs";
      /** Page the values were transcribed from. */
      url: string;
    };

/** One curated enum. */
export interface EnumOverlayEntry {
  /** CloudFormation type name, e.g. `AWS::EC2::Instance`. */
  type: string;
  /**
   * JSON pointer to the property inside that type's Registry schema, either
   * `/properties/<Name>` or `/definitions/<Def>/properties/<Name>`.
   */
  pointer: string;
  /**
   * Name for the `definitions` entry this creates. The generator turns it into
   * an exported type named `<class>_<enumName>`, e.g. `Function_Runtime`.
   */
  enumName: string;
  /** Why this property earned a place in the first curated set. */
  note: string;
  source: EnumOverlaySource;
  /** ISO date the values were last read from `source`. */
  reviewed: string;
  values: string[];
}

/** What happened to one entry during a generation run. */
export interface EnumOverlayApplication {
  entry: EnumOverlayEntry;
  /**
   * `applied` narrowed the property; `redundant` left an upstream enum in
   * place; `absent` means the schema in hand does not declare the property,
   * which only a non-strict (fixture) run tolerates.
   */
  outcome: "applied" | "redundant" | "absent";
  /** For `redundant`, the values upstream already declared. */
  upstreamValues?: string[];
}

/** The curated entries, in file order. */
export function enumOverlayEntries(): EnumOverlayEntry[] {
  return overlayDocument.entries as EnumOverlayEntry[];
}

/** Entries grouped by CloudFormation type name. */
export function enumOverlayByType(
  entries: EnumOverlayEntry[] = enumOverlayEntries(),
): Map<string, EnumOverlayEntry[]> {
  const byType = new Map<string, EnumOverlayEntry[]>();
  for (const entry of entries) {
    const list = byType.get(entry.type);
    if (list) list.push(entry);
    else byType.set(entry.type, [entry]);
  }
  return byType;
}

/** A pointer segment that is not a plain object key is not addressable. */
function pointerSegments(pointer: string): string[] {
  if (!pointer.startsWith("/")) {
    throw new Error(`enum overlay pointer must start with "/": ${pointer}`);
  }
  return pointer.split("/").slice(1);
}

type SchemaNode = Record<string, unknown>;

function resolvePointer(doc: SchemaNode, pointer: string): SchemaNode | undefined {
  let node: unknown = doc;
  for (const segment of pointerSegments(pointer)) {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return undefined;
    node = (node as SchemaNode)[segment];
    if (node === undefined) return undefined;
  }
  if (typeof node !== "object" || node === null || Array.isArray(node)) return undefined;
  return node as SchemaNode;
}

/**
 * Apply the entries for one CloudFormation type to its raw schema bytes.
 *
 * Returns the (possibly rewritten) schema and one {@link EnumOverlayApplication}
 * per entry. Throws when an entry cannot be honoured, which is always a
 * curation bug rather than a spec quirk.
 *
 * `strict` is on for a run over the real schema zip and off for a run over the
 * trimmed fixtures under `src/testdata/schemas`, which legitimately drop
 * properties the overlay names. Only a strict run treats a missing property as
 * an error.
 */
export function applyEnumOverlay(
  typeName: string,
  data: Buffer | string,
  entries: EnumOverlayEntry[],
  opts: { strict?: boolean } = {},
): { data: Buffer | string; applications: EnumOverlayApplication[] } {
  if (entries.length === 0) return { data, applications: [] };
  const strict = opts.strict ?? false;

  const text = typeof data === "string" ? data : data.toString("utf-8");
  const doc = JSON.parse(text) as SchemaNode;
  const applications: EnumOverlayApplication[] = [];
  let changed = false;

  for (const entry of entries) {
    const where = `${entry.type}${entry.pointer}`;

    const target = resolvePointer(doc, entry.pointer);
    if (!target) {
      if (!strict) {
        applications.push({ entry, outcome: "absent" });
        continue;
      }
      throw new Error(
        `enum overlay entry ${where} names a property the schema does not declare. ` +
          `Either the property was renamed upstream or the entry is stale; fix or drop it in ` +
          `src/codegen/enum-overlay.json.`,
      );
    }

    if (Array.isArray(target.enum) && target.enum.length > 0) {
      applications.push({
        entry,
        outcome: "redundant",
        upstreamValues: target.enum as string[],
      });
      continue;
    }

    if (typeof target.$ref === "string") {
      throw new Error(
        `enum overlay entry ${where} targets a property that already refers to ` +
          `${target.$ref}; the overlay cannot own its type.`,
      );
    }

    const definitions = (doc.definitions ??= {}) as SchemaNode;
    if (entry.enumName in definitions) {
      throw new Error(
        `enum overlay entry ${where} would define ${entry.type}.${entry.enumName}, ` +
          `which the schema already declares. Pick a different enumName.`,
      );
    }

    // The definition gives the generator a name to export; the `enum` left on
    // the property is what `extractConstraints` copies into the lexicon
    // registry, where the LSP and the docs build read it.
    definitions[entry.enumName] = { type: "string", enum: [...entry.values] };
    target.$ref = `#/definitions/${entry.enumName}`;
    target.enum = [...entry.values];
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
 * Fail on any entry the run never reached.
 *
 * `strict` is on for a run over the real schema zip and off for a run over a
 * fixture subset, where most types are legitimately absent. A missing type in
 * a full run means the resource left the Registry and the entry is dead.
 */
export function assertOverlayCoverage(
  entries: EnumOverlayEntry[],
  seenTypes: Set<string>,
  strict: boolean,
): void {
  if (!strict) return;
  const missing = entries.filter((e) => !seenTypes.has(e.type));
  if (missing.length === 0) return;
  const names = [...new Set(missing.map((e) => e.type))].sort().join(", ");
  throw new Error(
    `enum overlay names ${missing.length} entr${missing.length === 1 ? "y" : "ies"} on ` +
      `type(s) the spec does not contain: ${names}. Drop them from ` +
      `src/codegen/enum-overlay.json or fix the type name.`,
  );
}

/** One warning line per entry upstream has caught up with. */
export function redundantOverlayWarnings(
  applications: EnumOverlayApplication[],
): Array<{ file: string; error: string }> {
  return applications
    .filter((a) => a.outcome === "redundant")
    .map((a) => ({
      file: `${a.entry.type}${a.entry.pointer}`,
      error:
        `enum overlay entry is redundant: the spec already declares ` +
        `${(a.upstreamValues ?? []).length} allowed value(s) here, and the spec wins. ` +
        `Retire the entry from src/codegen/enum-overlay.json.`,
    }));
}
