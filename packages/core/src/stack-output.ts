/**
 * Stack Output — marks a value for cross-stack export.
 *
 * When a child project declares `stackOutput(ref)`, the serializer emits
 * it into the template's Outputs section. The parent can then reference
 * it via `nestedStack().outputs.name`.
 */

import { DECLARABLE_MARKER, type Declarable } from "./declarable";
import { AttrRef } from "./attrref";
import { isIntrinsic, type Intrinsic } from "./intrinsic";
import { isAttrRefLike } from "./utils";

/**
 * Marker symbol for stack output identification.
 */
export const STACK_OUTPUT_MARKER = Symbol.for("chant.stackOutput");

/**
 * A stack output declaration — wraps an AttrRef into a Declarable
 * that serializers emit as a template Output.
 */
export interface StackOutput extends Declarable {
  readonly [STACK_OUTPUT_MARKER]: true;
  readonly [DECLARABLE_MARKER]: true;
  readonly lexicon: string;
  readonly entityType: string;
  readonly kind: "output";
  /** The exported value: a bare attribute reference, an intrinsic wrapping
   * one (e.g. `Join(",", zone.NameServers)`), or a literal string. */
  readonly sourceRef: AttrRef | Intrinsic | string;
  readonly description?: string;
  /** When set, the serializer emits a cross-stack export under this name
   * (CloudFormation `Output.Export.Name`) in addition to the plain output. */
  readonly exportName?: string;
}

/** Find the first AttrRef anywhere inside a value (walking intrinsics/objects/
 * arrays), so a wrapping intrinsic can still borrow its parent's lexicon.
 * Duck-type, not `instanceof` (chant #1137): a lexicon built against a
 * separate copy of `@intentius/chant` produces AttrRefs that fail
 * `instanceof AttrRef` here but carry the same shape — missing one would
 * make the walk recurse into the AttrRef's own (unhelpful) fields instead
 * of stopping on it, silently failing to find the anchor. */
function firstAttrRef(value: unknown, seen = new Set<unknown>()): AttrRef | undefined {
  if (value === null || typeof value !== "object" || seen.has(value)) return undefined;
  if (isAttrRefLike(value)) return value;
  seen.add(value);
  const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  for (const child of children) {
    const found = firstAttrRef(child, seen);
    if (found) return found;
  }
  return undefined;
}

/**
 * Type guard for StackOutput.
 */
export function isStackOutput(value: unknown): value is StackOutput {
  return (
    typeof value === "object" &&
    value !== null &&
    STACK_OUTPUT_MARKER in value &&
    (value as Record<symbol, unknown>)[STACK_OUTPUT_MARKER] === true
  );
}

/**
 * Create a stack output that exports an attribute reference for cross-stack use.
 *
 * @param ref - The AttrRef to export (e.g. `vpc.vpcId`)
 * @param options - Optional description for the output
 * @returns A StackOutput Declarable
 *
 * @example
 * ```ts
 * import { stackOutput } from "@intentius/chant";
 * import { vpc, subnet } from "./vpc";
 *
 * export const vpcId = stackOutput(vpc.vpcId);
 * export const subnetId = stackOutput(subnet.subnetId, {
 *   description: "Primary subnet ID",
 * });
 * ```
 */
export function stackOutput(
  ref: AttrRef | Intrinsic | string,
  options?: { description?: string; exportName?: string; lexicon?: string },
): StackOutput {
  // Duck-type, not `instanceof` (chant #1137): AttrRef also implements
  // Intrinsic (a global-symbol marker), so `isIntrinsic(ref)` alone already
  // happens to accept a foreign-copy AttrRef here — this check would not
  // misfire even with the raw `instanceof` left in. It is converted anyway
  // so the guard's own logic states the invariant explicitly ("ref must be
  // AttrRef-like or Intrinsic") rather than relying on that coincidence,
  // matching the anchor selection right below it, which does misbehave.
  if (typeof ref !== "string" && !isAttrRefLike(ref) && !isIntrinsic(ref)) {
    throw new Error(
      "stackOutput(ref): ref must be an attribute reference, an intrinsic wrapping one, or a literal string",
    );
  }
  if (typeof ref === "string" && !options?.lexicon) {
    throw new Error(
      "stackOutput(literal): a literal output has no entity to derive its lexicon from — pass options.lexicon",
    );
  }
  // Derive lexicon from the referenced entity — for a bare AttrRef, its parent;
  // for an intrinsic (Join etc.), the first AttrRef nested inside it. A
  // foreign-copy AttrRef failing raw `instanceof` here would fall to
  // `firstAttrRef`, which (before its own #1137 fix) would also miss it —
  // silently anchoring on nothing and recording `lexicon: "unknown"`.
  const anchor = typeof ref === "string" ? undefined : isAttrRefLike(ref) ? ref : firstAttrRef(ref);
  const parent = anchor?.parent.deref();
  const derived = parent && typeof (parent as Record<string, unknown>).lexicon === "string"
    ? (parent as Record<string, unknown>).lexicon as string
    : "unknown";
  const lexicon = options?.lexicon ?? derived;

  const output: StackOutput = {
    [STACK_OUTPUT_MARKER]: true,
    [DECLARABLE_MARKER]: true,
    lexicon,
    entityType: "chant:output",
    kind: "output",
    sourceRef: ref,
    description: options?.description,
    exportName: options?.exportName,
  };

  return output;
}
