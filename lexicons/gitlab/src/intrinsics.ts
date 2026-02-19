/**
 * GitLab CI/CD intrinsic functions.
 *
 * GitLab CI has a single intrinsic: the !reference tag.
 * CI/CD variables ($CI_*) are just strings, not intrinsic functions.
 */

import { INTRINSIC_MARKER, type Intrinsic } from "@intentius/chant/intrinsic";

/**
 * !reference tag intrinsic.
 * References another job's properties: !reference [job_name, key]
 */
export class ReferenceIntrinsic implements Intrinsic {
  readonly [INTRINSIC_MARKER] = true as const;
  private path: string[];

  constructor(...path: string[]) {
    this.path = path;
  }

  toJSON(): string[] {
    return this.path;
  }

  /**
   * YAML representation uses the !reference tag.
   */
  toYAML(): { tag: "!reference"; value: string[] } {
    return { tag: "!reference", value: this.path };
  }
}

/**
 * Create a !reference intrinsic.
 * Usage: reference("job_name", "script") → !reference [job_name, script]
 */
export function reference(...path: string[]): ReferenceIntrinsic {
  return new ReferenceIntrinsic(...path);
}
