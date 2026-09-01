import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { Serializer, SerializerResult } from "@intentius/chant/serializer";
import type { DiscoveryError, BuildError } from "@intentius/chant/errors";
import type { IntrinsicDef, LexiconPlugin } from "@intentius/chant/lexicon";
import type { BuildParamProvenance } from "@intentius/chant/provenance";
import { resolveProjectLexicons } from "@intentius/chant/cli";
import { awsSerializer, awsPlugin } from "@intentius/chant-lexicon-aws";
import { gcpSerializer, gcpPlugin } from "@intentius/chant-lexicon-gcp";
import { azureSerializer, azurePlugin } from "@intentius/chant-lexicon-azure";
import { k8sSerializer, k8sPlugin } from "@intentius/chant-lexicon-k8s";
import { gitlabSerializer, gitlabPlugin } from "@intentius/chant-lexicon-gitlab";
import { githubSerializer, githubPlugin } from "@intentius/chant-lexicon-github";
import { forgejoSerializer, forgejoPlugin } from "@intentius/chant-lexicon-forgejo";
import { helmSerializer, helmPlugin } from "@intentius/chant-lexicon-helm";
import { dockerSerializer, dockerPlugin } from "@intentius/chant-lexicon-docker";
import { temporalSerializer, temporalPlugin } from "@intentius/chant-lexicon-temporal";
import { flySerializer, flyPlugin } from "@intentius/chant-lexicon-fly";
import { cplnSerializer, cplnPlugin } from "@intentius/chant-lexicon-cpln";

/**
 * chant #1025 (epic #1019) — the corpus-discovery machinery shared by every
 * fold/run/JSON-boundary differential (`fold-differential.test.ts`,
 * `json-boundary-differential.test.ts`, …). Factored out of the original
 * #1025 harness so a new differential reuses the exact same corpus and
 * serializer/intrinsic wiring instead of forking it (chant#1045 Phase 1).
 */

const ROOT = resolve(import.meta.dirname, "..");

export const ALL_SERIALIZERS: Serializer[] = [
  awsSerializer,
  gcpSerializer,
  azureSerializer,
  k8sSerializer,
  gitlabSerializer,
  githubSerializer,
  forgejoSerializer,
  helmSerializer,
  dockerSerializer,
  temporalSerializer,
  flySerializer,
  cplnSerializer,
];

/**
 * One serializer per lexicon, keyed by the lexicon's directory name under
 * `lexicons/`. Used for `lexicons/*<dot>/examples/*` corpus entries — see
 * {@link discoverCorpus}'s doc for why those get only their own lexicon's
 * serializer rather than {@link ALL_SERIALIZERS}.
 */
export const SERIALIZER_BY_LEXICON: Record<string, Serializer> = {
  aws: awsSerializer,
  gcp: gcpSerializer,
  azure: azureSerializer,
  k8s: k8sSerializer,
  gitlab: gitlabSerializer,
  github: githubSerializer,
  forgejo: forgejoSerializer,
  helm: helmSerializer,
  docker: dockerSerializer,
  temporal: temporalSerializer,
  fly: flySerializer,
  cpln: cplnSerializer,
};

/**
 * chant #1039 — every loaded plugin's registered intrinsics, combined. The
 * differentials build directly through core's `build()` (not the CLI), so
 * they have to reproduce `cli/commands/build.ts`'s own
 * `options.plugins.flatMap(p => p.intrinsics?.() ?? [])` step for the fold
 * path to recognize any intrinsic tagged template (e.g. AWS `Sub`).
 */
export const ALL_INTRINSICS: IntrinsicDef[] = [
  awsPlugin,
  gcpPlugin,
  azurePlugin,
  k8sPlugin,
  gitlabPlugin,
  githubPlugin,
  forgejoPlugin,
  helmPlugin,
  dockerPlugin,
  temporalPlugin,
  flyPlugin,
  cplnPlugin,
].flatMap((plugin) => plugin.intrinsics?.() ?? []);

/**
 * chant #1131 — the plugin objects themselves, for the differentials that
 * drive the CLI's `buildCommand` rather than core's `build()` (the
 * `lint.policies` half of `sandbox-execution-boundary.test.ts`).
 * `buildCommand` takes `plugins` to run each lexicon's own post-synth checks;
 * without them a corpus build through the CLI would be quietly weaker than a
 * real `chant build`.
 */
export const ALL_PLUGINS: LexiconPlugin[] = [
  awsPlugin,
  gcpPlugin,
  azurePlugin,
  k8sPlugin,
  gitlabPlugin,
  githubPlugin,
  forgejoPlugin,
  helmPlugin,
  dockerPlugin,
  temporalPlugin,
  flyPlugin,
  cplnPlugin,
];

/** One lexicon's own plugin, keyed the same way as {@link SERIALIZER_BY_LEXICON}. */
export const PLUGIN_BY_LEXICON: Record<string, LexiconPlugin> = {
  aws: awsPlugin,
  gcp: gcpPlugin,
  azure: azurePlugin,
  k8s: k8sPlugin,
  gitlab: gitlabPlugin,
  github: githubPlugin,
  forgejo: forgejoPlugin,
  helm: helmPlugin,
  docker: dockerPlugin,
  temporal: temporalPlugin,
  fly: flyPlugin,
  cpln: cplnPlugin,
};

/**
 * One lexicon's own intrinsics, keyed the same way as
 * {@link SERIALIZER_BY_LEXICON}.
 */
export const INTRINSICS_BY_LEXICON: Record<string, IntrinsicDef[]> = {
  aws: awsPlugin.intrinsics?.() ?? [],
  gcp: gcpPlugin.intrinsics?.() ?? [],
  azure: azurePlugin.intrinsics?.() ?? [],
  k8s: k8sPlugin.intrinsics?.() ?? [],
  gitlab: gitlabPlugin.intrinsics?.() ?? [],
  github: githubPlugin.intrinsics?.() ?? [],
  forgejo: forgejoPlugin.intrinsics?.() ?? [],
  helm: helmPlugin.intrinsics?.() ?? [],
  docker: dockerPlugin.intrinsics?.() ?? [],
  temporal: temporalPlugin.intrinsics?.() ?? [],
  fly: flyPlugin.intrinsics?.() ?? [],
  cpln: cplnPlugin.intrinsics?.() ?? [],
};

/**
 * chant #1062 — how a corpus entry classifies for a single `{ fold: true }`
 * probe build: "fold" (every file folded, zero execution), "run-fallback"
 * (at least one file fell back to running), or "empty" (no fold decisions
 * at all — nothing exported). Shared by every consumer that needs this
 * classification — `fold-differential.test.ts`'s own report/regression
 * gate/coverage guard, and `scripts/generate-fold-coverage.ts` — so there's
 * one definition of "counts as folding", not a copy per caller that could
 * quietly diverge.
 */
export type FoldMode = "fold" | "run-fallback" | "empty";

export function classifyFoldMode(foldDecisions: Array<{ mode: "fold" | "run" }>): FoldMode {
  if (foldDecisions.length === 0) return "empty";
  return foldDecisions.every((d) => d.mode === "fold") ? "fold" : "run-fallback";
}

export interface CorpusEntry {
  /** Repo-relative label used in test names and the report. */
  name: string;
  /** Absolute path to the source directory `build()` is pointed at. */
  srcDir: string;
  /** Serializers to build this entry with. */
  serializers: Serializer[];
  /** Intrinsics to fold with (chant #1039) — see {@link ALL_INTRINSICS}/{@link INTRINSICS_BY_LEXICON}. */
  intrinsics: IntrinsicDef[];
  /** The plugin objects matching {@link serializers} — only needed by a differential that drives the CLI's `buildCommand` (chant #1131). */
  plugins: LexiconPlugin[];
  /**
   * chant #1063 — the lexicon NAMES active for this entry, matching the
   * serializer/intrinsic selection below. The differentials build through
   * core's `build()` rather than the CLI, so — exactly as they already do for
   * `intrinsics` — they have to reproduce `cli/commands/build.ts`'s own
   * `options.plugins.map(p => p.name)` step, or the fold path would be
   * measured without the bare-specifier allowlist real `chant build --fold`
   * gives it.
   */
  lexicons: string[];
}

/** Every lexicon name the corpus can build with — the keys of {@link SERIALIZER_BY_LEXICON}. */
export const ALL_LEXICONS: string[] = Object.keys(SERIALIZER_BY_LEXICON);

const buildParamsCache = new Map<string, Promise<BuildParamProvenance[]>>();

/**
 * chant #1712 — this entry's declared build-time parameters
 * (`chant.config.ts`'s `buildParams`), resolved the way the CLI resolves them.
 *
 * `build()` takes already-resolved values and does no declaration or
 * validation of its own; that lives in the CLI layer
 * (`cli/build-params-cli.ts`). So a differential building through `build()`
 * has to reproduce the step — the same reason it already reproduces
 * `intrinsics`, `plugins` and `lexicons`, and the same consequence if it
 * doesn't.
 *
 * The consequence is not only a pessimistic measurement. `fold-import.ts`
 * gates its `params` substitution on the build having supplied parameters, so
 * an entry that migrated off `process.env` reads as run-fallback. And an
 * unresolved parameter is plain `undefined`, which the two sides of the JSON
 * boundary do not agree about: the run path serializes it as `null`, while
 * `JSON.stringify` drops the key. `examples/cockroachdb-multi-region-gke`'s
 * ClusterSecretStore `projectID` failed exactly there.
 *
 * Cached per source directory: every differential resolves the same entry,
 * and the resolution reads (and evaluates) a `chant.config.ts`.
 */
export function entryBuildParams(entry: CorpusEntry): Promise<BuildParamProvenance[]> {
  const cached = buildParamsCache.get(entry.srcDir);
  if (cached) return cached;
  const resolved = (async () => {
    const [{ loadChantConfigUpward }, { resolveBuildParams }] = await Promise.all([
      import("@intentius/chant/config"),
      import("@intentius/chant/build-params"),
    ]);
    const { config } = await loadChantConfigUpward(entry.srcDir);
    if (!config.buildParams) return [];
    return resolveBuildParams(config.buildParams, { env: process.env }).provenance;
  })();
  buildParamsCache.set(entry.srcDir, resolved);
  return resolved;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every buildable source directory in the corpus. Walks `examples/` and
 * each `lexicons/*<dot>/examples/` for subdirectories that carry a `src/`
 * folder — the same shape `describeAllExamples` (test-utils) auto-discovers
 * examples by.
 *
 * Serializer selection:
 *  - Root `examples/*<dot>/src` tutorials are built with every serializer
 *    ({@link ALL_SERIALIZERS}) — these tutorials deliberately combine a
 *    handful of lexicons (aws+k8s, gcp+k8s, gitlab+aws, …) and passing the
 *    full set costs nothing (`build()` only invokes a serializer for
 *    lexicons actually discovered).
 *  - `lexicons/*<dot>/examples/*<dot>/src` build fixtures are built with the
 *    lexicons THAT FIXTURE'S OWN `chant.config.ts` declares (chant #1996),
 *    resolved the same way `chant build` itself resolves them
 *    (`resolveProjectLexicons`, ../packages/core/src/cli/plugins.ts) —
 *    reading `lexicons` from the fixture's config, falling back to a plain
 *    text scan of its source when the config declares none. Most fixtures
 *    declare only their directory's own lexicon, matching precedent (every
 *    lexicon's own `examples/examples.test.ts` builds with that lexicon's
 *    serializer alone, e.g. `lexicons/helm/examples/examples.test.ts` uses
 *    `helmSerializer`), but a fixture that opts a SECOND lexicon in — e.g.
 *    `lexicons/helm/examples/stateful-service` declaring `["helm", "k8s"]` —
 *    is built with both, so `--sandbox`'s active-lexicon allowlist matches
 *    what a real `chant build` for that directory would grant. Forcing the
 *    single directory lexicon regardless of the fixture's own config (the
 *    pre-#1996 behavior) UNDER-reported the allowlist for exactly that case:
 *    `stateful-service` folds fully under a real `chant build --fold
 *    --sandbox`, but read as demoted here because `k8s` — active for that
 *    fixture's real build — was never in `lexicons`, so arm 1 of
 *    `isTrustedExecutableBinding` (chant #1093) refused a `k8s` construction
 *    the CLI would actually have trusted.
 *
 *    A helm chart embedding `@intentius/chant-lexicon-k8s` resources
 *    (`StatefulSet`, `Container`, …) as template values, not as
 *    independently-deployable k8s manifests, is still why `k8sSerializer`
 *    stays OUT of a fixture that doesn't declare `k8s` itself — running it
 *    over those nested, helm-intrinsic-bearing objects tries to serialize
 *    them as standalone k8s YAML, which breaks regardless of fold. That's a
 *    real pre-existing bug the differential's first draft
 *    (all-serializers-everywhere) surfaced as a false positive; it
 *    reproduces identically with `fold: false`, so it's an artifact of the
 *    harness's serializer choice, not of folding — see the #1025
 *    implementation notes. #1996 only widens the harness to match a
 *    fixture's OWN declared set, never beyond it.
 */
/**
 * Fixtures every differential suite must NOT build (#2035). The two suites
 * disagreed: `lexicons/helm/examples/examples.test.ts` skips
 * `helm-render-external-secrets` explicitly ("fetches a real upstream chart
 * at build time"), while this corpus built it in all six differential
 * suites — passing only because CI installs helm and the runner has
 * outbound network; on a cold runner the suite reached
 * `charts.external-secrets.io`. The hermetic coverage for the HelmRender
 * codepath is `render.test.ts`, via a local chart. Keyed by corpus entry
 * name.
 */
const NETWORK_FIXTURES = new Set(["lexicons/helm/examples/helm-render-external-secrets"]);

export async function discoverCorpus(): Promise<CorpusEntry[]> {
  const entries: CorpusEntry[] = [];

  const examplesDir = resolve(ROOT, "examples");
  for (const dirent of readdirSync(examplesDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const srcDir = resolve(examplesDir, dirent.name, "src");
    if (isDir(srcDir)) {
      entries.push({
        name: `examples/${dirent.name}`,
        srcDir,
        serializers: ALL_SERIALIZERS,
        intrinsics: ALL_INTRINSICS,
        plugins: ALL_PLUGINS,
        lexicons: ALL_LEXICONS,
      });
    }
  }

  const lexiconsDir = resolve(ROOT, "lexicons");
  for (const lexDirent of readdirSync(lexiconsDir, { withFileTypes: true })) {
    if (!lexDirent.isDirectory()) continue;
    const serializer = SERIALIZER_BY_LEXICON[lexDirent.name];
    if (!serializer) continue;
    const lexExamplesDir = resolve(lexiconsDir, lexDirent.name, "examples");
    if (!isDir(lexExamplesDir)) continue;
    for (const exDirent of readdirSync(lexExamplesDir, { withFileTypes: true })) {
      if (!exDirent.isDirectory()) continue;
      const srcDir = resolve(lexExamplesDir, exDirent.name, "src");
      if (isDir(srcDir)) {
        // chant #1996 — the fixture's OWN declared lexicons, not just the
        // directory it happens to live under; falls back to `[lexDirent.name]`
        // only if resolution comes back empty (defensive — every fixture seen
        // in practice declares at least its own directory's lexicon, either
        // explicitly or via `resolveProjectLexicons`'s own source-scan
        // fallback).
        const entryName = `lexicons/${lexDirent.name}/examples/${exDirent.name}`;
        if (NETWORK_FIXTURES.has(entryName)) continue;
        const resolvedNames = await resolveProjectLexicons(srcDir);
        const lexiconNames = resolvedNames.length > 0 ? resolvedNames : [lexDirent.name];
        entries.push({
          name: entryName,
          srcDir,
          serializers: lexiconNames.map((n) => SERIALIZER_BY_LEXICON[n]).filter((s): s is Serializer => s !== undefined),
          intrinsics: lexiconNames.flatMap((n) => INTRINSICS_BY_LEXICON[n] ?? []),
          plugins: lexiconNames.map((n) => PLUGIN_BY_LEXICON[n]).filter((p): p is LexiconPlugin => p !== undefined),
          lexicons: lexiconNames,
        });
      }
    }
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * chant #1112 — `build()` from whatever module graph is CURRENT, rather than
 * the one that happened to be loaded when this file was first evaluated.
 *
 * Every differential here retries a mismatch with `vi.resetModules()` (to
 * rule out `propagate()`'s in-place mutation compounding across two builds of
 * the same directory). That reset re-instantiates the module registry, so the
 * project files a subsequent build imports get a FRESH copy of chant-core —
 * while a statically imported `build` keeps running the ORIGINAL copy. The
 * two halves then disagree on object identity across the seam, and the
 * baseline silently degrades: `collectEntities` decides whether an export is
 * an output with `isLexiconOutput` (`../packages/core/src/lexicon-output.ts`),
 * so a stale `build` classifies a fresh `LexiconOutput` as an ordinary,
 * ignorable export and drops it. The run side loses its whole `Outputs`
 * section too — and a fold path that had dropped outputs for a real reason
 * then compares EQUAL to it and reports `[identical]`.
 *
 * That is exactly how #1112 hid: `lexicons/aws/examples/lambda-function` (a
 * folding entry with an `output(...)`) drifted on the fast path, took the
 * retry, and came back "identical" because neither side had outputs any more.
 * Worse, the registry reset is global for the rest of the file's run, so ONE
 * entry needing the retry silently disarmed every entry sorted after it.
 *
 * Loading `build` per call closes it: both sides of every comparison are
 * built by the same graph the project files were loaded into, so a fold-side
 * drop has nothing to cancel against. Without a reset this is just a cache
 * hit on an already-loaded module.
 */
export async function loadBuild(): Promise<typeof import("@intentius/chant/build").build> {
  return (await import("@intentius/chant/build")).build;
}

/**
 * The JSON-entity-boundary pair (`json-boundary-differential.test.ts`), loaded
 * from the current module graph for the same reason as {@link loadBuild}.
 * Both halves together, since they have to agree on the entity types they
 * hand each other.
 */
export async function loadEntityWireBuild(): Promise<{
  discoverEntitySetJson: typeof import("@intentius/chant/discovery/entity-wire").discoverEntitySetJson;
  buildFromEntitiesJson: typeof import("@intentius/chant/build").buildFromEntitiesJson;
}> {
  const [{ discoverEntitySetJson }, { buildFromEntitiesJson }] = await Promise.all([
    import("@intentius/chant/discovery/entity-wire"),
    import("@intentius/chant/build"),
  ]);
  return { discoverEntitySetJson, buildFromEntitiesJson };
}

/** A build's outputs, normalized to plain strings for byte-exact comparison. */
export type NormalizedOutputs = Record<string, { primary: string; files: Record<string, string> }>;

export function normalizeOutputs(outputs: Map<string, string | SerializerResult>): NormalizedOutputs {
  const normalized: NormalizedOutputs = {};
  for (const [lexicon, value] of outputs) {
    normalized[lexicon] =
      typeof value === "string"
        ? { primary: value, files: {} }
        : { primary: value.primary, files: { ...(value.files ?? {}) } };
  }
  return normalized;
}

/** Order-independent, byte-exact equality check — used for the printed report only (the gate is `expect().toEqual()`, which gives a real diff on failure). */
export function outputsEqual(a: NormalizedOutputs, b: NormalizedOutputs): boolean {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length || aKeys.some((k, i) => k !== bKeys[i])) return false;
  for (const key of aKeys) {
    if (a[key].primary !== b[key].primary) return false;
    const aFiles = Object.keys(a[key].files).sort();
    const bFiles = Object.keys(b[key].files).sort();
    if (aFiles.length !== bFiles.length || aFiles.some((k, i) => k !== bFiles[i])) return false;
    for (const f of aFiles) {
      if (a[key].files[f] !== b[key].files[f]) return false;
    }
  }
  return true;
}

/** Normalize discovery/build errors for order-independent comparison across two build paths. */
export function normalizeErrors(errors: Array<DiscoveryError | BuildError>): string[] {
  return errors.map((e) => JSON.stringify(e.toJSON())).sort();
}
