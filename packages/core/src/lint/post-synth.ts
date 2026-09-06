import type { Declarable } from "../declarable";
import type { ActivityContract } from "../op/activity-contract";
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
  /**
   * Activity contracts resolved across every lexicon this build configured
   * (chant #2101), keyed by activity name — core's own plus whatever each
   * lexicon contributes at `@intentius/chant-lexicon-<name>/op/activity-contracts`
   * or through its plugin. Filled in by `chant build`, `chant lint` and
   * `check-lexicon`'s example harness via `loadActivityContracts`.
   *
   * The checks that validate Op steps against contracts (OPS012 and OPS013,
   * `./rules/op/`) merge this over their own statically imported table with
   * `mergeActivityContracts`, so an Op calling `terraformPlan` or
   * `k3sInstall` validates against the contract the owning lexicon declared
   * instead of failing for the absence of one. Optional, and absent from a
   * hand-built context: a check must behave as it did before this existed
   * when it is `undefined`.
   */
  readonly activityContracts?: ReadonlyMap<string, ActivityContract>;
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
 *
 * chant #2111 finds a narrower anchor that does generalize: `./suppressions.ts`'s
 * `applyInlineSuppressions` matches `entity` against `ctx.entities` (a map key
 * every context already carries, source-level, before serialization), not
 * against a name in the synthesized OUTPUT. A lexicon whose entities carry a
 * `suppressions` field (see that file's module doc) gets inline `# chant-
 * ignore`-style comments this way; one that doesn't is unaffected, and this
 * interface's own contract (no `file`/`line`) is unchanged either way.
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
  /**
   * Set when the finding is that something does not exist, rather than that
   * something present is wrong (chant #2113). TF001 (no remote backend) is
   * the motivating case: there is no resource to set `entity` to, only the
   * scope that is missing one. Snyk's policy-engine spec names this the
   * "missing-resource" archetype (a `deny` whose `info` carries a
   * `resource_type` instead of a `resource`, because there is nothing to
   * attach to) and is the only tool in chant's TF-family survey with a
   * first-class shape for it; trivy's own inline-ignore comments admit they
   * cannot suppress an absence finding for exactly this reason. `kind` names
   * what is missing (a `backend`/`cloud` block, a required resource type);
   * `scope` names where it is missing (a root module name, a file). Renders
   * distinctly in all three reporters (stylish/JSON/SARIF, `../cli/commands/
   * audit.ts` and `../audit/report-model.ts`) instead of falling back to
   * `entity`, and gives #2111's HCL suppression a block-anchored key to
   * suppress an absence finding by (the block that *should* declare `kind`
   * inside `scope`), independent of whatever `entity` this diagnostic sets.
   */
  missing?: {
    /** What kind of thing is absent (e.g. `"backend"`, `"cloud"`). */
    kind: string;
    /** Where it is missing from (e.g. a root module name). */
    scope: string;
  };
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
 * into the context so a check can branch on the current environment/stack, and
 * `opts.activityContracts` (chant #2101) carries the build's cross-lexicon
 * activity-contract map to the checks that validate Op steps against it.
 */
export function runPostSynthChecks(
  checks: PostSynthCheck[],
  buildResult: PostSynthContext["buildResult"],
  env?: string,
  opts?: { activityContracts?: ReadonlyMap<string, ActivityContract> },
): PostSynthDiagnostic[] {
  const getDocs = createDocsAccessor(buildResult.outputs);
  const ctx: PostSynthContext = {
    outputs: buildResult.outputs,
    entities: buildResult.entities,
    env,
    buildResult,
    ...(opts?.activityContracts ? { activityContracts: opts.activityContracts } : {}),
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
