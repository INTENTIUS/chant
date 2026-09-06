/**
 * Fold provenance (#2161) — which composite parameter produced which emitted field.
 *
 * A composite is the one lossy thing chant emits. It takes a few typed
 * arguments and expands to several resources, so a return leg that regenerates
 * source from live produces flat typed resources and the composite is gone. The
 * projection is not invertible from its output alone, which is the view-update
 * problem landing on chant's record.
 *
 * chant can answer it where a general generator cannot, and for one reason: the
 * evaluated subset is restricted on purpose. `discovery/fold-import.ts` already
 * interprets an admissible factory body rather than calling it, so the
 * expression each member property was WRITTEN as is in hand at build time. The
 * same pass records where the field came from, in `discovery/param-deps.ts`'s
 * {@link import("./discovery/param-deps").collectCompositeOrigins}.
 *
 * ## Four answers, and the fourth is a real one
 *
 * Every emitted path gets one of {@link FoldFieldOrigin}'s four kinds. Three of
 * them are findings; `unknown` is the fourth, and it is a legal answer rather
 * than a gap. A build that expanded a composite without interpreting its body
 * (the run path, a factory outside the admissible subset, a sandboxed child
 * whose provenance did not survive the wire) knows the field came from a
 * composite and cannot say which parameter. Recording that is the whole point:
 * an unknown must never fall through to `direct`, because `direct` licenses
 * editing the field in the user's source and an unattributed composite field is
 * exactly the case where that produces a flattened resource.
 *
 * `direct` is claimed only where the build has a provenance record AND that
 * record says no composite expanded the entity. Absence of a record is
 * `unknown`, never `direct`.
 *
 * ## Beside the output, never in it
 *
 * The record is build metadata, not declared configuration, and it must not
 * reach the document an applier writes. It rides two channels, both outside the
 * apply-bound document, and neither is a new mechanism:
 *
 *  - per entity, the non-enumerable symbol-keyed side channel `./provenance.ts`
 *    already owns, invisible to every serializer and to every spread;
 *  - per build, {@link import("./build").BuildResult.foldProvenance}, a sibling
 *    of `buildParams` and `lexiconVersions`.
 *
 * Nothing is added to `SerializeContext`. That is the same posture
 * `./effect-receipt.ts` takes at the same seam, one notch stricter: a receipt
 * rides `SerializeContext.receipts` so a lexicon MAY render it outside
 * `Resources`, whereas provenance has no rendering and is simply never handed
 * to a serializer at all. `fold-provenance-exclusion.test.ts` drives a real
 * build through a spy serializer and a mock applier to hold that line.
 *
 * ## The return leg
 *
 * {@link resolveDriftedField} is the consumer. #2160 has already ruled out the
 * fields nobody declared, so a drifted field reaching it is one source actually
 * declared, and the origin decides what may be proposed:
 *
 *  - a composite parameter: propose changing that parameter, naming the file,
 *    the composite call and the parameter path. One line, composite intact.
 *  - a literal the composite fixes: refuse by name. The choice is to
 *    parameterize the field or stop using the composite there, and neither is
 *    something chant may pick.
 *  - a direct declaration: today's behaviour, unchanged.
 *  - unknown: today's behaviour, and say that is what happened.
 *
 * Proposing is as far as this goes. Rewriting a parameter in the user's source
 * is a source-edit problem (the generator half of `chant import` emits whole
 * files and nothing maps a property path back to a location in a `.ts` file),
 * so a proposal here is a described action: it names the file, the composite
 * call and the parameter path, and performs no edit.
 */

import { isResourceDeclarable, type Declarable } from "./declarable";
import { originOfPath, type EntityProvenance, type PathOrigin } from "./provenance";
import type { DeepEntityDrift, PropertyDrift } from "./lifecycle/deep-diff";

/** Why a field's origin could not be determined. Both are facts about the BUILD, not about the field. */
export type UnknownOriginReason =
  /**
   * A composite expanded the entity and this build did not interpret its body,
   * so parameter and fixed literal are indistinguishable. The run path, a
   * factory outside `fold-import.ts`'s admissible subset, and a `propagate()`
   * key both sides wrote all land here.
   */
  | "composite-not-interpreted"
  /**
   * The build recorded no provenance for this entity at all, so not even "did a
   * composite make it" is answerable. A sandboxed child's entities arrive this
   * way: `discovery/entity-wire-codec.ts` drops build metadata over the wire.
   */
  | "no-provenance";

/**
 * What produced one emitted property path.
 *
 * The composite kinds carry `instance` — the export name every member of one
 * composite call shares — because "the `AutoscaledService` composite" is not an
 * address and "the `api` call of `AutoscaledService`" is.
 */
export type FoldFieldOrigin =
  | { kind: "composite-parameter"; composite: string; instance?: string; parameters: string[] }
  | { kind: "composite-literal"; composite: string; instance?: string }
  | { kind: "direct" }
  | { kind: "unknown"; reason: UnknownOriginReason };

/** One entity's fold provenance: where it was declared, and an origin for every field it emits. */
export interface EntityFoldProvenance {
  /** The source file that declared the entity, when the build recorded one. */
  sourceFile?: string;
  /** The composite type that expanded it, when one did. */
  composite?: string;
  /** The composite call (export name) it belongs to, when one expanded it. */
  instance?: string;
  /**
   * Emitted property path to origin, in sorted key order. Every path the entity
   * emits is present: a path with no attribution carries an `unknown` origin
   * rather than being left out, so a consumer iterating fields never has to
   * decide what a missing key meant.
   */
  fields: Record<string, FoldFieldOrigin>;
}

/** A whole build's fold provenance, keyed by chant entity name. */
export type FoldProvenance = Record<string, EntityFoldProvenance>;

/** True for an ordinary `{}`, false for an array, a class instance, an `AttrRef`. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Every property path an entity's `props` emits, in `EntityProvenance.paths`'
 * grammar: dotted names only, plain objects descended into, everything else
 * attributed whole at its own path.
 *
 * Arrays are deliberately not indexed. An index-shaped key would not survive an
 * element moving, and the recorder that produces origins cannot index either,
 * so indexing here would manufacture paths nothing can ever attribute. The diff
 * addresses array elements with `[#key]`/`[n]` and `originOfPath` resolves
 * those against the dotted key that covers them, which is the join between the
 * two grammars.
 *
 * An empty object is a value, and a leaf. An `undefined` value is not emitted
 * and yields no path.
 */
export function emittedFieldPaths(props: unknown): string[] {
  const out: string[] = [];

  const walk = (value: unknown, prefix: string): void => {
    if (value === undefined) return;
    if (isPlainObject(value)) {
      const keys = Object.keys(value).sort();
      if (keys.length === 0) {
        if (prefix) out.push(prefix);
        return;
      }
      for (const key of keys) walk(value[key], prefix ? `${prefix}.${key}` : key);
      return;
    }
    if (prefix) out.push(prefix);
  };

  walk(props, "");
  return out;
}

/**
 * The four-way answer for one path, from the recorded {@link PathOrigin} and
 * the entity's own provenance.
 *
 * `origin` is what {@link originOfPath} resolved for the path, so a coarse key
 * recorded at an ancestor governs a leaf, exactly as it does everywhere else.
 */
export function classifyFieldOrigin(
  origin: PathOrigin | undefined,
  provenance: EntityProvenance | undefined,
): FoldFieldOrigin {
  if (!provenance) return { kind: "unknown", reason: "no-provenance" };
  const instance = provenance.compositeInstance;

  switch (origin?.kind) {
    case "composite-parameter":
      return {
        kind: "composite-parameter",
        composite: origin.composite,
        ...(instance ? { instance } : {}),
        parameters: [...origin.parameters],
      };
    case "composite-literal":
      return { kind: "composite-literal", composite: origin.composite, ...(instance ? { instance } : {}) };
    case "composite":
      // The coarse kind: a composite expanded this, and nothing said which
      // parameter. Not a parameter, not a fixed literal, and above all not a
      // direct declaration.
      return { kind: "unknown", reason: "composite-not-interpreted" };
    case "authored":
    case "build-param":
      // A build parameter governs the expression the AUTHOR wrote in their own
      // source, so the declaration is still theirs to edit.
      return { kind: "direct" };
    case undefined:
      return provenance.composite
        ? { kind: "unknown", reason: "composite-not-interpreted" }
        : { kind: "direct" };
  }
}

/** One entity's fold provenance, or `undefined` when it emits no properties at all. */
export function foldProvenanceOfEntity(
  entity: Declarable,
  provenance: EntityProvenance | undefined,
): EntityFoldProvenance | undefined {
  if (!isResourceDeclarable(entity)) return undefined;
  const paths = emittedFieldPaths(entity.props);
  if (paths.length === 0) return undefined;

  const fields: Record<string, FoldFieldOrigin> = {};
  for (const path of paths) {
    fields[path] = classifyFieldOrigin(originOfPath(provenance?.paths, path), provenance);
  }

  return {
    ...(provenance?.sourceFile ? { sourceFile: provenance.sourceFile } : {}),
    ...(provenance?.composite ? { composite: provenance.composite } : {}),
    ...(provenance?.compositeInstance ? { instance: provenance.compositeInstance } : {}),
    fields,
  };
}

/**
 * A whole build's fold provenance.
 *
 * `provenanceOf` is injected rather than read off the entity here so the same
 * function serves a build (where it is `getProvenance`) and a test with a
 * hand-written record. Entities with no properties are absent; sorted, because
 * a build's outputs are compared byte for byte.
 */
export function foldProvenanceOfEntities(
  entities: ReadonlyMap<string, Declarable>,
  provenanceOf: (entity: Declarable) => EntityProvenance | undefined,
): FoldProvenance {
  const out: FoldProvenance = {};
  for (const name of [...entities.keys()].sort()) {
    const entity = entities.get(name) as Declarable;
    const record = foldProvenanceOfEntity(entity, provenanceOf(entity));
    if (record) out[name] = record;
  }
  return out;
}

/** One-line rendering of a field origin, for a report. */
export function describeFoldFieldOrigin(origin: FoldFieldOrigin): string {
  switch (origin.kind) {
    case "composite-parameter":
      return `parameter ${origin.parameters.join(", ")} of ${compositeCall(origin.composite, origin.instance)}`;
    case "composite-literal":
      return `fixed by ${compositeCall(origin.composite, origin.instance)}`;
    case "direct":
      return "declared directly";
    case "unknown":
      return `origin unknown (${unknownOriginText(origin.reason)})`;
  }
}

/** Why an origin could not be determined, in words a report can print. */
export function unknownOriginText(reason: UnknownOriginReason): string {
  switch (reason) {
    case "composite-not-interpreted":
      return "expanded by a composite whose factory this build did not interpret";
    case "no-provenance":
      return "this build recorded no provenance for the entity";
  }
}

/** `AutoscaledService composite call \`api\``, or just the composite when the call has no name. */
function compositeCall(composite: string, instance: string | undefined): string {
  return instance ? `the \`${instance}\` call of composite ${composite}` : `composite ${composite}`;
}

/** `in src/app.infra.ts`, or nothing when the build recorded no file. */
function inFile(sourceFile: string | undefined): string {
  return sourceFile ? ` in ${sourceFile}` : "";
}

/** A value as a report prints it. */
function renderValue(value: unknown): string {
  if (value === undefined) return "unset";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * What the return leg may do about one drifted field.
 *
 * Every arm is a DESCRIBED action. Nothing here edits a file, and
 * `propose-parameter` deliberately stops at naming the edit: the source-edit
 * half is the generator side of `chant import` and does not exist yet.
 */
export type DriftResolution =
  | {
      kind: "propose-parameter";
      composite: string;
      instance?: string;
      sourceFile?: string;
      /** The factory parameter paths that govern the field. */
      parameters: string[];
      description: string;
    }
  | {
      kind: "refuse-fixed";
      composite: string;
      instance?: string;
      sourceFile?: string;
      description: string;
    }
  | { kind: "edit-declaration"; sourceFile?: string; description: string }
  | { kind: "fall-back"; reason: UnknownOriginReason; sourceFile?: string; description: string };

/** One drifted field and what may be done about it. */
export interface FieldReconcile {
  entity: string;
  path: string;
  declared?: unknown;
  live?: unknown;
  origin: FoldFieldOrigin;
  resolution: DriftResolution;
}

/**
 * Classify one drifted field by its origin.
 *
 * The caller has already established this is drift in #2160's sense: a path
 * source declared, whose live value moved. Undeclared fields are held
 * elsewhere and never reach here, so the only question left is which of the
 * four origins produced the field.
 */
export function resolveDriftedField(input: {
  entity: string;
  path: string;
  declared?: unknown;
  live?: unknown;
  origin?: PathOrigin;
  provenance?: EntityProvenance;
}): FieldReconcile {
  const origin = classifyFieldOrigin(input.origin, input.provenance);
  const sourceFile = input.provenance?.sourceFile;
  const move = `${renderValue(input.declared)} to ${renderValue(input.live)}`;

  const resolution: DriftResolution = ((): DriftResolution => {
    switch (origin.kind) {
      case "composite-parameter": {
        const parameters = origin.parameters;
        return {
          kind: "propose-parameter",
          composite: origin.composite,
          ...(origin.instance ? { instance: origin.instance } : {}),
          ...(sourceFile ? { sourceFile } : {}),
          parameters: [...parameters],
          description:
            `change ${parameters.length === 1 ? "parameter" : "parameters"} ` +
            `${parameters.map((p) => `\`${p}\``).join(", ")} of ` +
            `${compositeCall(origin.composite, origin.instance)}${inFile(sourceFile)} ` +
            `so \`${input.path}\` moves from ${move}. The composite stays.`,
        };
      }
      case "composite-literal":
        return {
          kind: "refuse-fixed",
          composite: origin.composite,
          ...(origin.instance ? { instance: origin.instance } : {}),
          ...(sourceFile ? { sourceFile } : {}),
          description:
            `refused: \`${input.path}\` is fixed by ${compositeCall(origin.composite, origin.instance)}` +
            `${inFile(sourceFile)}, so no argument at the call site moves it. ` +
            `Parameterize the field in composite ${origin.composite}, or stop using the composite here.`,
        };
      case "direct":
        return {
          kind: "edit-declaration",
          ...(sourceFile ? { sourceFile } : {}),
          description: `change the declared value of \`${input.path}\`${inFile(sourceFile)} from ${move}.`,
        };
      case "unknown":
        return {
          kind: "fall-back",
          reason: origin.reason,
          ...(sourceFile ? { sourceFile } : {}),
          description:
            `origin unknown (${unknownOriginText(origin.reason)}), so falling back to changing the ` +
            `declared value of \`${input.path}\`${inFile(sourceFile)} from ${move}.`,
        };
    }
  })();

  return {
    entity: input.entity,
    path: input.path,
    ...("declared" in input ? { declared: input.declared } : {}),
    ...("live" in input ? { live: input.live } : {}),
    origin,
    resolution,
  };
}

/**
 * Every drifted field in a deep diff, classified.
 *
 * Reads `drifted` only. `heldElsewhere` is somebody else's field and
 * `accepted` is a difference the baseline holds back, and neither may become an
 * update, so neither is offered a resolution.
 *
 * A drift row of kind `absent` has no live value: the field is declared and the
 * cloud does not have it. That is still drift on a declared path, and the same
 * four origins decide what may be proposed about it.
 */
export function resolveDeepDrift(
  drifted: readonly DeepEntityDrift[],
  provenanceOf: (entity: string) => EntityProvenance | undefined,
): FieldReconcile[] {
  const out: FieldReconcile[] = [];
  for (const entity of drifted) {
    const provenance = provenanceOf(entity.name);
    for (const change of entity.changes as readonly PropertyDrift[]) {
      out.push(
        resolveDriftedField({
          entity: entity.name,
          path: change.path,
          ...("declared" in change ? { declared: change.declared } : {}),
          ...("live" in change ? { live: change.live } : {}),
          ...(change.origin ? { origin: change.origin } : {}),
          ...(provenance ? { provenance } : {}),
        }),
      );
    }
  }
  return out;
}
