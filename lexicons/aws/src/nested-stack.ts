/**
 * AWS NestedStack — references a child project directory that builds
 * to an independent CloudFormation template. The parent emits
 * AWS::CloudFormation::Stack pointing at the child template.
 *
 * Cross-stack references are explicit: the child declares `stackOutput()`
 * exports, and the parent reads them via `nestedStack().outputs.name`.
 */

import { CHILD_PROJECT_MARKER, type ChildProjectInstance } from "@intentius/chant/child-project";
import { DECLARABLE_MARKER } from "@intentius/chant/declarable";
import { INTRINSIC_MARKER } from "@intentius/chant/intrinsic";

/**
 * Marker symbol for nested stack identification.
 */
export const NESTED_STACK_MARKER = Symbol.for("chant.aws.nestedStack");

/**
 * Options for configuring a nested stack.
 */
export interface NestedStackOptions {
  /** Explicit CloudFormation Parameters to pass to the child stack */
  parameters?: Record<string, unknown>;
}

/**
 * A reference to an output from a nested stack.
 * Serializes to `{ "Fn::GetAtt": [stackLogicalName, "Outputs.OutputName"] }`.
 */
export class NestedStackOutputRef {
  readonly [INTRINSIC_MARKER] = true as const;
  readonly stackName: string;
  readonly outputName: string;

  constructor(stackName: string, outputName: string) {
    this.stackName = stackName;
    this.outputName = outputName;
  }

  toJSON(): { "Fn::GetAtt": [string, string] } {
    return {
      "Fn::GetAtt": [this.stackName, `Outputs.${this.outputName}`],
    };
  }
}

/**
 * Type guard for NestedStackOutputRef.
 */
export function isNestedStackOutputRef(value: unknown): value is NestedStackOutputRef {
  return value instanceof NestedStackOutputRef;
}

/**
 * Extended ChildProjectInstance with AWS-specific marker.
 */
export interface NestedStackInstance extends ChildProjectInstance {
  readonly [NESTED_STACK_MARKER]: true;
}

/**
 * Type guard for NestedStackInstance.
 */
export function isNestedStackInstance(value: unknown): value is NestedStackInstance {
  return (
    typeof value === "object" &&
    value !== null &&
    NESTED_STACK_MARKER in value &&
    (value as Record<symbol, unknown>)[NESTED_STACK_MARKER] === true
  );
}

/**
 * Create a nested stack that references a child project directory.
 *
 * The child directory must contain its own `_.ts` barrel and resource files.
 * It can be built independently with `chant build`. Cross-stack outputs
 * are declared in the child via `stackOutput()`.
 *
 * @param name - Logical name for the nested stack resource
 * @param projectPath - Absolute path to the child project directory
 * @param options - Optional parameters to pass to the child stack
 * @returns A ChildProjectInstance with an `outputs` proxy for cross-stack refs
 *
 * @example
 * ```ts
 * const network = _.nestedStack("network", import.meta.dirname + "/network", {
 *   parameters: { Environment: "prod" },
 * });
 *
 * export const handler = new _.Function({
 *   vpcConfig: {
 *     subnetIds: [network.outputs.subnetId],  // cross-stack ref
 *   },
 * });
 * ```
 */
export function nestedStack(
  name: string,
  projectPath: string,
  options?: NestedStackOptions,
): NestedStackInstance {
  const outputsProxy = new Proxy({} as Record<string, NestedStackOutputRef>, {
    get(_, prop: string) {
      if (typeof prop === "symbol") return undefined;
      return new NestedStackOutputRef(name, prop);
    },
  });

  const instance = {
    [CHILD_PROJECT_MARKER]: true,
    [DECLARABLE_MARKER]: true,
    [NESTED_STACK_MARKER]: true,
    lexicon: "aws",
    entityType: "AWS::CloudFormation::Stack",
    kind: "resource" as const,
    projectPath,
    logicalName: name,
    outputs: outputsProxy,
    options: options ?? {},
  } as NestedStackInstance;

  return instance;
}
