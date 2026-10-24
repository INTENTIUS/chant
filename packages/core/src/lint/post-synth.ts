import type { Declarable } from "../declarable";
import type { ActivityContract } from "../op/activity-contract";
import type { SerializerResult } from "../serializer";
import type { TelemetryAttribution } from "../telemetry-attribution";
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
  /**
   * The telemetry attribution the build stamped (#2558), from
   * `resolveTelemetryAttribution`. Set when the project is inside a workspace
   * or sets `telemetry.attribution: true`, and absent at level 0 and from a
   * hand-built context. OTEL118 runs only when it is set.
   */
  readonly telemetry?: TelemetryAttribution;
  /**
   * The directory of the project config the build loaded (#3751): where a
   * relative `sourceDir` resolves, and so where a check looks for a file the
   * project keeps beside its source (the sql lexicon's `sql-types.d.ts`).
   * Set by `chant build` and `chant lint`; absent from a hand-built context,
   * where a check that reads the disk stays silent.
   */
  readonly projectDir?: string;
  /**
   * The project config the build loaded (#3751), as source lint rules get it
   * in `LintContext.projectConfig`. A check that renders output again, as the
   * sql lexicon's does for `sql-types.d.ts`, needs the settings the build ran
   * with. Absent from a hand-built context.
   */
  readonly projectConfig?: Record<string, unknown>;
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
  /**
   * The build root the finding is about, set by a {@link CrossRootCheck}
   * (chant #1939). Absent from a per-build finding.
   */
  root?: string;
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
  /**
   * `chant audit` skips this check unless the project enables it with a
   * `lint.rules` entry for its id (chant #3190). Builds are not affected: they
   * already filter by the lexicon's `lintPresets()`. It exists because the
   * audit runs every check a lexicon ships, report-only ones included, so a
   * new check would otherwise change the audit output of every project.
   */
  auditOptIn?: boolean;
  /**
   * `"build"`, the default: the check sees one build. A check that reads
   * across build roots is a {@link CrossRootCheck} instead (chant #1939).
   */
  scope?: "build";
}

/**
 * Structural type guard — used to collect project-authored policy checks.
 * A {@link CrossRootCheck} is not a `PostSynthCheck`, so a policy module or a
 * lexicon's check directory that exports one never puts it in a per-build run.
 */
export function isPostSynthCheck(value: unknown): value is PostSynthCheck {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PostSynthCheck).id === "string" &&
    typeof (value as PostSynthCheck).description === "string" &&
    typeof (value as PostSynthCheck).check === "function" &&
    (value as { scope?: unknown }).scope !== "cross-root"
  );
}

/**
 * Run a set of post-synthesis checks against a build result. `env` is threaded
 * into the context so a check can branch on the current environment/stack, and
 * `opts.activityContracts` (chant #2101) carries the build's cross-lexicon
 * activity-contract map to the checks that validate Op steps against it.
 * `opts.telemetry` is the build's resolved telemetry attribution, and
 * `opts.projectDir` and `opts.projectConfig` the config the build loaded and
 * its directory.
 */
export function runPostSynthChecks(
  checks: PostSynthCheck[],
  buildResult: PostSynthContext["buildResult"],
  env?: string,
  opts?: { activityContracts?: ReadonlyMap<string, ActivityContract>; telemetry?: TelemetryAttribution; projectDir?: string; projectConfig?: Record<string, unknown> },
): PostSynthDiagnostic[] {
  const getDocs = createDocsAccessor(buildResult.outputs);
  const ctx: PostSynthContext = {
    outputs: buildResult.outputs,
    entities: buildResult.entities,
    env,
    buildResult,
    ...(opts?.activityContracts ? { activityContracts: opts.activityContracts } : {}),
    ...(opts?.telemetry ? { telemetry: opts.telemetry } : {}),
    ...(opts?.projectDir ? { projectDir: opts.projectDir } : {}),
    ...(opts?.projectConfig ? { projectConfig: opts.projectConfig } : {}),
    get docs(): OutputDoc[] {
      return getDocs();
    },
  };

  const diagnostics: PostSynthDiagnostic[] = [];
  for (const check of checks) {
    // chant #1939: a cross-root check never runs in a per-build pass, even
    // when a caller hands one over untyped. runCrossRootChecks runs it.
    if ((check as { scope?: unknown }).scope === "cross-root") continue;
    diagnostics.push(...check.check(ctx));
  }
  return diagnostics;
}

// ---------------------------------------------------------------------------
// Cross-build-root mode (chant #1939)
// ---------------------------------------------------------------------------

/**
 * One build root handed to {@link runCrossRootChecks}: a name, and the build
 * result the caller already has for it. The caller decides what a root is
 * (a workspace member, a project directory, an environment's build) and
 * builds it; this module never builds or reads the disk.
 */
export interface CrossRootInput {
  /**
   * The root's name, unique within one run. A workspace member's name, or a
   * project-relative path. Findings name it in {@link PostSynthDiagnostic.root}.
   */
  root: string;
  /** The root's directory, when it has one. */
  dir?: string;
  /** The environment this root was built for, when known. */
  env?: string;
  buildResult: PostSynthContext["buildResult"];
  projectConfig?: Record<string, unknown>;
}

/**
 * One build root as a cross-root check sees it: an ordinary
 * {@link PostSynthContext} over that root's build, so a per-build helper
 * (k8s's `allManifests(ctx)`) works on it unchanged, plus its name.
 */
export interface BuildRootView extends PostSynthContext {
  readonly root: string;
  readonly dir?: string;
  readonly docs: OutputDoc[];
}

/** An {@link OutputDoc} tagged with the build root it came from. */
export interface RootedOutputDoc extends OutputDoc {
  root: string;
}

/**
 * A link between two build roots, as the caller knows it (chant #2549): in a
 * workspace, a member link from the declaration or one the members' graphs
 * surface. A cross-root check that compares what the outputs say with what
 * was written down reads these from {@link CrossRootContext.links}.
 */
export interface CrossRootLink {
  consumer: string;
  producer: string;
  output: string;
  /** How the link was found: `declared`, `kind-reader`, or `inferred:<rule>` for one the roots' graphs surface. */
  origin: string;
  /** The consumer's parameter an inferred link feeds; null or absent for a declared one. */
  input?: string | null;
  /** Whether the link resolved against the producer's outputs, as the caller judged it. */
  status?: string;
}

/** An entity tagged with the build root that declared it. */
export interface RootedEntity {
  root: string;
  name: string;
  entity: Declarable;
}

/**
 * Context provided to a {@link CrossRootCheck}. `roots` keeps every root's
 * build apart; `docs` and `entities` are the union across roots, each entry
 * tagged with its root, built lazily on first access.
 */
export interface CrossRootContext {
  /** Every root in the run, in the order the caller gave them. */
  readonly roots: readonly BuildRootView[];
  /** Look a root up by name. */
  root(name: string): BuildRootView | undefined;
  /** Every root's parsed output documents, tagged by root. Lazy. */
  readonly docs: readonly RootedOutputDoc[];
  /** Every root's entities, tagged by root. Lazy. */
  readonly entities: readonly RootedEntity[];
  /** The run's environment, when the caller set one for the whole run. */
  readonly env?: string;
  readonly activityContracts?: ReadonlyMap<string, ActivityContract>;
  /** The links between roots the caller passed (#2549), or absent when it passed none. */
  readonly links?: readonly CrossRootLink[];
}

/** What a cross-root run takes besides its roots. */
export interface CrossRootOptions {
  env?: string;
  activityContracts?: ReadonlyMap<string, ActivityContract>;
  /** The links between roots (#2549), handed to every check as {@link CrossRootContext.links}. */
  links?: readonly CrossRootLink[];
}

/**
 * A check that reads across build roots (chant #1939). It declares
 * `scope: "cross-root"`, and only {@link runCrossRootChecks} runs it:
 * `chant build`, `chant lint` and every other per-build pass skip it, so a
 * project that never asks for a cross-root run pays nothing for it.
 */
export interface CrossRootCheck {
  id: string;
  description: string;
  scope: "cross-root";
  check(ctx: CrossRootContext): PostSynthDiagnostic[];
  /** As {@link PostSynthCheck.auditOptIn}. */
  auditOptIn?: boolean;
}

/** Structural type guard for {@link CrossRootCheck}. */
export function isCrossRootCheck(value: unknown): value is CrossRootCheck {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as CrossRootCheck).id === "string" &&
    typeof (value as CrossRootCheck).description === "string" &&
    typeof (value as CrossRootCheck).check === "function" &&
    (value as CrossRootCheck).scope === "cross-root"
  );
}

/**
 * Build the {@link CrossRootContext} for a set of roots. Exported for tests
 * and for a caller that runs checks itself; most callers want
 * {@link runCrossRootChecks}. Throws on an empty or duplicate root name.
 */
export function createCrossRootContext(
  inputs: readonly CrossRootInput[],
  opts?: CrossRootOptions,
): CrossRootContext {
  const seen = new Set<string>();
  const roots: BuildRootView[] = inputs.map((input) => {
    if (input.root.length === 0) throw new Error("cross-root run: a build root needs a name");
    if (seen.has(input.root)) throw new Error(`cross-root run: build root "${input.root}" appears twice`);
    seen.add(input.root);
    const getDocs = createDocsAccessor(input.buildResult.outputs);
    const env = input.env ?? opts?.env;
    return {
      root: input.root,
      ...(input.dir ? { dir: input.dir, projectDir: input.dir } : {}),
      outputs: input.buildResult.outputs,
      entities: input.buildResult.entities,
      env,
      buildResult: input.buildResult,
      ...(opts?.activityContracts ? { activityContracts: opts.activityContracts } : {}),
      ...(input.projectConfig ? { projectConfig: input.projectConfig } : {}),
      get docs(): OutputDoc[] {
        return getDocs();
      },
    };
  });
  const byName = new Map(roots.map((r) => [r.root, r]));
  let docs: RootedOutputDoc[] | undefined;
  let entities: RootedEntity[] | undefined;
  return {
    roots,
    root: (name) => byName.get(name),
    get docs(): readonly RootedOutputDoc[] {
      docs ??= roots.flatMap((r) => r.docs.map((d) => ({ ...d, root: r.root })));
      return docs;
    },
    get entities(): readonly RootedEntity[] {
      entities ??= roots.flatMap((r) =>
        [...r.entities].map(([name, entity]) => ({ root: r.root, name, entity })),
      );
      return entities;
    },
    ...(opts?.env ? { env: opts.env } : {}),
    ...(opts?.activityContracts ? { activityContracts: opts.activityContracts } : {}),
    ...(opts?.links ? { links: opts.links } : {}),
  };
}

/**
 * Run the cross-root checks in `checks` over `roots` (chant #1939). Anything
 * in `checks` that is not a {@link CrossRootCheck} is skipped, so a caller can
 * pass a lexicon's whole check list. With no cross-root check to run it
 * returns at once, without building a context.
 */
export function runCrossRootChecks(
  checks: ReadonlyArray<CrossRootCheck | PostSynthCheck>,
  roots: readonly CrossRootInput[],
  opts?: CrossRootOptions,
): PostSynthDiagnostic[] {
  const selected = checks.filter(isCrossRootCheck);
  if (selected.length === 0) return [];
  const ctx = createCrossRootContext(roots, opts);
  const diagnostics: PostSynthDiagnostic[] = [];
  for (const check of selected) diagnostics.push(...check.check(ctx));
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
