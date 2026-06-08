import type { Declarable } from "../declarable";
import type { SerializerResult } from "../serializer";
import type { Severity } from "./rule";

/**
 * Context provided to post-synthesis checks.
 */
export interface PostSynthContext {
  /** The build result outputs (lexicon name → serialized output) */
  outputs: Map<string, string | SerializerResult>;
  /** Map of entity name to Declarable entity */
  entities: Map<string, Declarable>;
  /**
   * The environment/stack being built, if known (from `--env` or the project's
   * `ownership.env`). Lets an organizational policy branch on environment —
   * e.g. "no public buckets in prod". Undefined when no environment is set.
   */
  env?: string;
  /** Raw build result object */
  buildResult: {
    outputs: Map<string, string | SerializerResult>;
    entities: Map<string, Declarable>;
    warnings: string[];
    errors: Array<{ message: string; name: string }>;
    sourceFileCount: number;
  };
}

/**
 * Extract the primary content string from a serializer output.
 */
export function getPrimaryOutput(output: string | SerializerResult): string {
  return typeof output === "string" ? output : output.primary;
}

/**
 * A diagnostic from a post-synthesis check.
 */
export interface PostSynthDiagnostic {
  /** ID of the check that produced this diagnostic */
  checkId: string;
  /** Severity level */
  severity: Severity;
  /** Human-readable message */
  message: string;
  /** Optional entity name related to this diagnostic */
  entity?: string;
  /** Optional lexicon related to this diagnostic */
  lexicon?: string;
}

/**
 * A post-synthesis check that validates build output. Lexicons ship these as
 * domain rules; projects author them as organizational policy (see the
 * `lint.policies` config and the Organizational Policy guide).
 */
export interface PostSynthCheck {
  /** Unique identifier for this check */
  id: string;
  /** Human-readable description */
  description: string;
  /** Execute the check and return diagnostics */
  check(ctx: PostSynthContext): PostSynthDiagnostic[];
}

/** Structural type guard — used to collect project-authored policy checks. */
export function isPostSynthCheck(value: unknown): value is PostSynthCheck {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PostSynthCheck).id === "string" &&
    typeof (value as PostSynthCheck).description === "string" &&
    typeof (value as PostSynthCheck).check === "function"
  );
}

/**
 * Run a set of post-synthesis checks against a build result. `env` is threaded
 * into the context so a check can branch on the current environment/stack.
 */
export function runPostSynthChecks(
  checks: PostSynthCheck[],
  buildResult: PostSynthContext["buildResult"],
  env?: string,
): PostSynthDiagnostic[] {
  const ctx: PostSynthContext = {
    outputs: buildResult.outputs,
    entities: buildResult.entities,
    env,
    buildResult,
  };

  const diagnostics: PostSynthDiagnostic[] = [];
  for (const check of checks) {
    diagnostics.push(...check.check(ctx));
  }
  return diagnostics;
}
