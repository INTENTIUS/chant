import type { Declarable } from "../declarable";
import type { SerializerResult } from "../serializer";
import type { Severity } from "./rule";
import { parseOutputDocs, type OutputDoc } from "./output-docs";

export { parseOutputDocs, pick, get, type OutputDoc } from "./output-docs";

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
  /**
   * Parsed output documents (chant #975) — `ctx.outputs` run through
   * `parseOutputDocs` once and cached. A lazy `readonly` getter, not a plain
   * field: computed on first access and shared across every check in the
   * run, so a check that only reads `entities` pays nothing, and no two
   * checks re-parse the same YAML/JSON. See `./output-docs.ts`.
   *
   * Optional at the type level — NOT because it can be absent from a real
   * build. Every context chant itself constructs (`runPostSynthChecks`
   * below, `@intentius/chant-test-utils`'s `createPostSynthContext` and
   * `makePostSynthCtx*`) wires it up via `createDocsAccessor` and it is
   * always present there. It is typed optional only so the many lexicon
   * tests that build a `PostSynthContext` object literal by hand (predating
   * this field) keep compiling unchanged, per this issue's own "existing
   * checks compile unchanged" constraint — a new check that wants `ctx.docs`
   * should still get a real array from every context chant builds; guard
   * with `ctx.docs ?? []` only when a context's provenance is unknown.
   */
  readonly docs?: OutputDoc[];
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
 * Build the lazy, memoized `docs` accessor shared by `runPostSynthChecks`
 * (below) and `@intentius/chant-test-utils`'s `createPostSynthContext` — the
 * two places a `PostSynthContext` gets constructed. Returns a zero-arg
 * function suitable for a `get docs()` object-literal accessor; the first
 * call parses, every later call returns the same cached array.
 */
export function createDocsAccessor(
  outputs: Map<string, string | SerializerResult>,
): () => OutputDoc[] {
  let cached: OutputDoc[] | undefined;
  return () => {
    if (cached === undefined) {
      cached = parseOutputDocs(outputs);
    }
    return cached;
  };
}

/**
 * Extract the primary content string from a serializer output.
 */
export function getPrimaryOutput(output: string | SerializerResult): string {
  return typeof output === "string" ? output : output.primary;
}

/**
 * Extract the ADDITIONAL files from a serializer output — everything
 * {@link getPrimaryOutput} discards.
 *
 * Every post-synth check shipped before this one reads the primary output
 * only, which means a sidecar file (a nested stack template, committed SOPS
 * ciphertext) is invisible to all of them. That is the right default — the
 * primary output is what appliers read — but a rule ABOUT a sidecar has to
 * be able to see it, and `PostSynthContext.outputs` has carried the data all
 * along. WK8504 (k8s) is the first caller.
 */
export function getAdditionalFiles(output: string | SerializerResult): Record<string, string> {
  return typeof output === "string" ? {} : (output.files ?? {});
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
  const getDocs = createDocsAccessor(buildResult.outputs);
  const ctx: PostSynthContext = {
    outputs: buildResult.outputs,
    entities: buildResult.entities,
    env,
    buildResult,
    get docs(): OutputDoc[] {
      return getDocs();
    },
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
