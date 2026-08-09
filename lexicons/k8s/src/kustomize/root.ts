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
import { renderedManifestEntity } from "./rendered-entity";

const KUSTOMIZATION_FILES = ["kustomization.yaml", "kustomization.yml", "Kustomization"];

export interface KustomizeRootsResult {
  entities: Map<string, Declarable>;
  warnings: string[];
}

/** `Deployment` + `my-app` → `deploymentMyApp`, the import path's naming. */
function logicalId(kind: string, name: string | undefined): string {
  const prefix = kind.charAt(0).toLowerCase() + kind.slice(1);
  if (!name) return prefix;
  const pascal = name
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return `${prefix}${pascal}`;
}

/**
 * Render each configured kustomization root into entities, keyed
 * `<root>/<kindName>` (namespace-qualified, then numbered, on collision).
 */
export async function renderKustomizeRoots(opts: {
  /** Directory the project config was loaded from; relative roots resolve against it. */
  projectRoot: string;
  /** `k8s.kustomize.roots` — kustomization dirs, usually relative. */
  roots: readonly string[];
  /** Injectable renderer (tests); defaults to the real subprocess runner. */
  run?: KustomizeRunner;
}): Promise<KustomizeRootsResult> {
  const run = opts.run ?? defaultKustomizeRunner;
  const entities = new Map<string, Declarable>();
  const warnings: string[] = [];

  for (const root of opts.roots) {
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

    const documents = await renderKustomizeDocuments(rootDir, run);
    for (const doc of documents) {
      const entity = renderedManifestEntity(doc, rootLabel);
      if (!entity) {
        warnings.push(`kustomize root "${rootLabel}" rendered a document without apiVersion/kind — skipped`);
        continue;
      }
      const metadata = entity.props.metadata as Record<string, unknown>;
      const kind = entity.props.kind as string;
      const name = typeof metadata.name === "string" ? metadata.name : undefined;
      const namespace = typeof metadata.namespace === "string" ? metadata.namespace : undefined;

      // Deterministic, human-readable keys. Two documents can share
      // kind+name (different namespaces, or different API groups with the
      // same kind word) — qualify by namespace first, then number.
      const base = `${rootLabel}/${logicalId(kind, name)}`;
      let key = base;
      if (entities.has(key) && namespace) key = `${base}.${namespace}`;
      for (let n = 2; entities.has(key); n++) key = `${base}~${n}`;
      entities.set(key, entity);
    }
  }

  return { entities, warnings };
}
