/**
 * Reading a workspace member into the graph (#3179).
 *
 * `chant workspace graph` writes a reader project for a member of kind
 * `kustomize`, `argo-app` or `flux-kustomization`, with `k8s.member` in its
 * config (see `workspace-kinds.json`). The k8s plugin's `buildRoots` hook calls
 * {@link readK8sMember}, and the objects it returns are the member's nodes.
 *
 * - `kustomize` renders the directory through the kustomize runner (`kustomize
 *   build`, `kubectl kustomize` fallback). With neither binary installed there
 *   is nothing to read: the member contributes no objects and its report says
 *   `rendered: false` with the reason. A render the binary ran and refused is
 *   not that case and still throws.
 * - `argo-app` and `flux-kustomization` read the directory's YAML files and keep
 *   the documents of their kind. No binary is involved.
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadAll } from "js-yaml";
import type { Declarable } from "@intentius/chant/declarable";
import { defaultKustomizeRunner, KustomizeBinaryMissingError, renderKustomizeDocuments, type KustomizeRunner } from "./kustomize/render";
import { addRenderedEntity, renderedManifestEntity } from "./kustomize/rendered-entity";

export type K8sMemberKind = "kustomize" | "argo-app" | "flux-kustomization";

export interface K8sMemberConfig {
  kind: K8sMemberKind;
  dir: string;
  label?: string;
}

/** What one member's read found, carried on the graph's `meta.k8sMember`. */
export interface K8sMemberReport {
  kind: K8sMemberKind;
  /** Kustomize only: false when the render could not run. */
  rendered?: boolean;
  /** Why nothing was read; set with `rendered: false`. */
  reason?: string;
  /** The objects the member contributed. */
  objects: number;
}

/** The apiVersion group and kind each manifest kind is made of. */
const MANIFEST_KINDS: Record<Exclude<K8sMemberKind, "kustomize">, { group: string; kind: string }> = {
  "argo-app": { group: "argoproj.io", kind: "Application" },
  "flux-kustomization": { group: "kustomize.toolkit.fluxcd.io", kind: "Kustomization" },
};

function objectDocuments(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const doc of loadAll(text)) {
    if (doc && typeof doc === "object" && !Array.isArray(doc)) out.push(doc as Record<string, unknown>);
  }
  return out;
}

/** The documents of `kind` in the YAML files directly in `dir`, in file-name order. */
function manifestDocuments(dir: string, kind: Exclude<K8sMemberKind, "kustomize">): Array<Record<string, unknown>> {
  const want = MANIFEST_KINDS[kind];
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  const docs: Array<Record<string, unknown>> = [];
  for (const file of files) {
    for (const doc of objectDocuments(readFileSync(join(dir, file), "utf-8"))) {
      const apiVersion = doc.apiVersion;
      if (typeof apiVersion === "string" && apiVersion.startsWith(`${want.group}/`) && doc.kind === want.kind) docs.push(doc);
    }
  }
  return docs;
}

export async function readK8sMember(opts: {
  member: K8sMemberConfig;
  /** Injectable renderer (tests); defaults to the real subprocess runner. */
  run?: KustomizeRunner;
}): Promise<{ entities: Map<string, Declarable>; warnings: string[]; report: K8sMemberReport }> {
  const { member } = opts;
  const label = member.label ?? basename(member.dir);
  const entities = new Map<string, Declarable>();
  const warnings: string[] = [];

  let documents: Array<Record<string, unknown>>;
  let rendered: boolean | undefined;
  let reason: string | undefined;
  if (member.kind === "kustomize") {
    try {
      documents = await renderKustomizeDocuments(member.dir, opts.run ?? defaultKustomizeRunner);
      rendered = true;
    } catch (err) {
      if (!(err instanceof KustomizeBinaryMissingError)) throw err;
      documents = [];
      rendered = false;
      reason = err.message;
      warnings.push(`kustomize member "${label}" was not rendered: ${err.message}`);
    }
  } else {
    documents = manifestDocuments(member.dir, member.kind);
  }

  for (const doc of documents) {
    const entity = renderedManifestEntity(doc, label);
    if (!entity) {
      warnings.push(`${member.kind} member "${label}" has a document without apiVersion/kind; skipped`);
      continue;
    }
    addRenderedEntity(entities, label, entity);
  }

  return {
    entities,
    warnings,
    report: { kind: member.kind, ...(rendered === undefined ? {} : { rendered }), ...(reason ? { reason } : {}), objects: entities.size },
  };
}

let lastReport: K8sMemberReport | undefined;

/**
 * The report of the read in this process. `graphMeta` receives only the
 * entities, so the hook that read the member leaves its report here for the
 * hook that publishes it; `chant graph` runs the two in order in one process.
 */
export function setLastMemberReport(report: K8sMemberReport | undefined): void {
  lastReport = report;
}

export function lastMemberReport(): K8sMemberReport | undefined {
  return lastReport;
}
