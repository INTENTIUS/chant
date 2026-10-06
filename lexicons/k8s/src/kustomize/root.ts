/**
 * Kustomize build roots (#1548 piece 3).
 *
 * An estate that keeps its overlay tree has no typed chant source for those
 * manifests — and piece 4 (a declarable Kustomization) is parked precisely
 * because forcing a modelling migration onto every kustomize estate is the
 * mistake behold#138 documented. What such an estate CAN declare is the
 * directory: `k8s.kustomize.roots` in `chant.config.ts` names kustomization
 * dirs that render at build time into the manifest set. The rendered
 * documents become entities (see `./rendered-entity.ts`), so they are
 * serialized into the build output, ownership-stamped, seen by post-synth
 * checks, and observed by `lifecycle diff --live` — the declared side an
 * overlay estate never had.
 *
 * Renders through the same injectable runner the `kustomize-apply`
 * capability uses (`./render.ts`): `kustomize build`, `kubectl kustomize`
 * fallback, and a both-binaries-missing failure that names them. Two
 * build-time guarantees on top:
 *
 * - **Deterministic**: entity names derive from the root dir plus each
 *   document's kind/name/namespace, disambiguated in render order — the same
 *   overlay renders the same entity set every build.
 * - **Fail loudly, not weirdly**: a root that doesn't exist, or a dir with no
 *   kustomization file, refuses with the path in the message before any
 *   subprocess runs — offline, the failure mode is a sentence, never a
 *   render attempt's stack trace.
 */
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Declarable } from "@intentius/chant/declarable";
import { defaultKustomizeRunner, renderKustomizeDocuments, type KustomizeRunner } from "./render";
import { addRenderedEntity, renderedManifestEntity } from "./rendered-entity";
import { applyRenderedPatches, type RenderedPatch } from "../patch/rendered-patch";

/**
 * One `k8s.kustomize.roots` entry: a directory, or a directory plus patches
 * applied to its rendered documents (#3566).
 */
export type KustomizeRootEntry = string | { path: string; patches?: RenderedPatch[] };

const KUSTOMIZATION_FILES = ["kustomization.yaml", "kustomization.yml", "Kustomization"];

export interface KustomizeRootsResult {
  entities: Map<string, Declarable>;
  warnings: string[];
}

/**
 * Render each configured kustomization root into entities, keyed
 * `<root>/<kindName>` (namespace-qualified, then numbered, on collision).
 */
export async function renderKustomizeRoots(opts: {
  /** Directory the project config was loaded from; relative roots resolve against it. */
  projectRoot: string;
  /** `k8s.kustomize.roots` — kustomization dirs, usually relative, optionally with patches. */
  roots: readonly KustomizeRootEntry[];
  /** Injectable renderer (tests); defaults to the real subprocess runner. */
  run?: KustomizeRunner;
}): Promise<KustomizeRootsResult> {
  const run = opts.run ?? defaultKustomizeRunner;
  const entities = new Map<string, Declarable>();
  const warnings: string[] = [];

  for (const entry of opts.roots) {
    const root = typeof entry === "string" ? entry : entry.path;
    const patches = typeof entry === "string" ? undefined : entry.patches;
    const rootDir = isAbsolute(root) ? root : resolve(opts.projectRoot, root);
    // The label rendered docs carry as provenance: the declared (relative)
    // form when possible, so it names the overlay the way the config does.
    const rootLabel = isAbsolute(root) ? (relative(opts.projectRoot, root) || ".") : root;

    if (!existsSync(rootDir)) {
      throw new Error(`k8s.kustomize.roots entry "${root}": directory not found at ${rootDir}`);
    }
    if (!KUSTOMIZATION_FILES.some((f) => existsSync(join(rootDir, f)))) {
      throw new Error(
        `k8s.kustomize.roots entry "${root}": ${rootDir} contains no kustomization file ` +
          `(expected one of ${KUSTOMIZATION_FILES.join(", ")})`,
      );
    }

    const rendered = await renderKustomizeDocuments(rootDir, run);
    const documents = applyRenderedPatches(rendered, patches, `kustomize root "${rootLabel}"`);
    for (const doc of documents) {
      const entity = renderedManifestEntity(doc, rootLabel);
      if (!entity) {
        warnings.push(`kustomize root "${rootLabel}" rendered a document without apiVersion/kind — skipped`);
        continue;
      }
      addRenderedEntity(entities, rootLabel, entity);
    }
  }

  return { entities, warnings };
}
