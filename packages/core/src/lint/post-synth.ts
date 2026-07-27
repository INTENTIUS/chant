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
 *
 * chant #1138 — deliberately carries no `file`/`line` the way `LintDiagnostic`
 * (`./rule.ts`) does. A post-synth check runs over `ctx.outputs` — the
 * SYNTHESIZED output text (a CloudFormation template, a Kubernetes manifest) —
 * not a `ts.SourceFile`, so there is no AST position to report in the first
 * place. `entity` (below) is the closest thing to a locator and is NOT a
 * substitute: it names a resource in that synthesized output (a CFN logical
 * id, a k8s `metadata.name`), which several checks in this repo never even
 * set (a cross-cutting check with no single implicated resource), and which
 * is not guaranteed to match a `ctx.entities` map key. This is why source-
 * comment (`chant-disable`) suppression is out of scope for post-synth
 * findings — see `./config.ts`'s `applyConfiguredSeverity` doc for the full
 * reasoning and what suppression surface post-synth findings get instead.
 */
export interface PostSynthDiagnostic {
  /** ID of the check that produced this diagnostic */
  checkId: string;
  /** Severity level */
  severity: Severity;
  /** Human-readable message */
  message: string;
  /**
   * Optional resource name related to this diagnostic — a name from the
   * SYNTHESIZED OUTPUT (a CFN logical id, a k8s `metadata.name`), not a
   * source file/line. See this interface's doc comment.
   */
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

// chant #1138 — `applyConfiguredSeverity` (the `lint.rules` severity-override
// pass over a set of `PostSynthDiagnostic`s) lives in `./config.ts`, not here,
// even though it operates on this module's own type. This file is a leaf:
// every lexicon's post-synth checks import it as a real runtime module (not
// just for types — `getPrimaryOutput` above is a plain function several
// checks call directly), so it has to stay cheap to load. `./config.ts` is
// not cheap — it resolves built-in preset paths via the runtime adapter at
// module scope — and pulling that into every lexicon's check barrel merely to
// share one filter function is the wrong trade. `applyConfiguredSeverity`
// only needs this module's TYPE (`PostSynthDiagnostic`), which costs nothing
// at runtime, so the dependency runs the other way instead.
