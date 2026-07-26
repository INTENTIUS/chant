import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { Serializer, SerializerResult } from "@intentius/chant/serializer";
import type { DiscoveryError, BuildError } from "@intentius/chant/errors";
import type { IntrinsicDef } from "@intentius/chant/lexicon";
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
].flatMap((plugin) => plugin.intrinsics?.() ?? []);

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
};

export interface CorpusEntry {
  /** Repo-relative label used in test names and the report. */
  name: string;
  /** Absolute path to the source directory `build()` is pointed at. */
  srcDir: string;
  /** Serializers to build this entry with. */
  serializers: Serializer[];
  /** Intrinsics to fold with (chant #1039) — see {@link ALL_INTRINSICS}/{@link INTRINSICS_BY_LEXICON}. */
  intrinsics: IntrinsicDef[];
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
 *  - `lexicons/*<dot>/examples/*<dot>/src` build fixtures are built with ONLY
 *    that lexicon's own serializer, matching how every lexicon's own
 *    `examples/examples.test.ts` already builds them (e.g.
 *    `lexicons/helm/examples/examples.test.ts` uses `helmSerializer` alone).
 *    This isn't just precedent for its own sake: a helm chart embeds
 *    `@intentius/chant-lexicon-k8s` resources (`StatefulSet`, `Container`, …)
 *    as template values, not as independently-deployable k8s manifests —
 *    running `k8sSerializer` over them too tries to serialize those nested,
 *    helm-intrinsic-bearing objects as standalone k8s YAML, which breaks
 *    regardless of fold. That's a real pre-existing bug the differential's
 *    first draft (all-serializers-everywhere) surfaced as a false positive;
 *    it reproduces identically with `fold: false`, so it's an artifact of
 *    the harness's serializer choice, not of folding — see the #1025
 *    implementation notes.
 */
export function discoverCorpus(): CorpusEntry[] {
  const entries: CorpusEntry[] = [];

  const examplesDir = resolve(ROOT, "examples");
  for (const dirent of readdirSync(examplesDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const srcDir = resolve(examplesDir, dirent.name, "src");
    if (isDir(srcDir)) {
      entries.push({ name: `examples/${dirent.name}`, srcDir, serializers: ALL_SERIALIZERS, intrinsics: ALL_INTRINSICS });
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
        entries.push({
          name: `lexicons/${lexDirent.name}/examples/${exDirent.name}`,
          srcDir,
          serializers: [serializer],
          intrinsics: INTRINSICS_BY_LEXICON[lexDirent.name] ?? [],
        });
      }
    }
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
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
