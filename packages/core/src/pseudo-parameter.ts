/**
 * Generic pseudo-parameter class for lexicon-provided global named references.
 *
 * AWS uses "AWS::StackName", Terraform has "path.module", Azure has
 * "subscription().id" — every format needs the same class that serializes
 * to a Ref-like structure and has the INTRINSIC_MARKER.
 */

import { INTRINSIC_MARKER, type Intrinsic } from "./intrinsic";

export class PseudoParameter implements Intrinsic {
  readonly [INTRINSIC_MARKER] = true as const;
  private refName: string;

  constructor(refName: string) {
    this.refName = refName;
  }

  toJSON(): { Ref: string } {
    return { Ref: this.refName };
  }

  toString(): string {
    return `\${${this.refName}}`;
  }
}

/**
 * Create a namespace of pseudo-parameters from a name map.
 *
 * @example
 * ```ts
 * export const { StackName, Region } = createPseudoParameters({
 *   StackName: "AWS::StackName",
 *   Region: "AWS::Region",
 * });
 * ```
 */
export function createPseudoParameters<T extends Record<string, string>>(
  nameMap: T,
): { [K in keyof T]: PseudoParameter } {
  const result = {} as Record<string, PseudoParameter>;
  for (const [key, refName] of Object.entries(nameMap)) {
    result[key] = new PseudoParameter(refName);
  }
  return result as { [K in keyof T]: PseudoParameter };
}
