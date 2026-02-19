/**
 * Stack Output — marks a value for cross-stack export.
 *
 * When a child project declares `stackOutput(ref)`, the serializer emits
 * it into the template's Outputs section. The parent can then reference
 * it via `nestedStack().outputs.name`.
 */

import { DECLARABLE_MARKER, type Declarable } from "./declarable";
import type { AttrRef } from "./attrref";

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
  readonly sourceRef: AttrRef;
  readonly description?: string;
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
 * import * as _ from "./_";
 *
 * export const vpcId = stackOutput(_.$.vpc.vpcId);
 * export const subnetId = stackOutput(_.$.subnet.subnetId, {
 *   description: "Primary subnet ID",
 * });
 * ```
 */
export function stackOutput(
  ref: AttrRef,
  options?: { description?: string },
): StackOutput {
  // Derive lexicon from the AttrRef's parent entity
  const parent = ref.parent.deref();
  const lexicon = parent && typeof (parent as any).lexicon === "string"
    ? (parent as any).lexicon
    : "unknown";

  const output: StackOutput = {
    [STACK_OUTPUT_MARKER]: true,
    [DECLARABLE_MARKER]: true,
    lexicon,
    entityType: "chant:output",
    kind: "output",
    sourceRef: ref,
    description: options?.description,
  };

  return output;
}
