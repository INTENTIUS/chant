/**
 * Reading a workspace member into the graph (#3179, #5096).
 *
 * `chant workspace graph` writes a reader project for a member of kind
 * `kustomize`, `argo-app`, `flux-kustomization` or `manifests`, with
 * `k8s.member` in its config (see `workspace-kinds.json`). The k8s plugin's
 * `buildRoots` hook calls {@link readK8sMember}, and the objects it returns are
 * the member's nodes.
 *
 * - `kustomize` renders the directory through the kustomize runner (`kustomize
 *   build`, `kubectl kustomize` fallback). With neither binary installed there
 *   is nothing to read: the member contributes no objects and its report says
 *   `rendered: false` with the reason. A render the binary ran and refused is
 *   not that case and still throws.
 * - `argo-app` and `flux-kustomization` read the directory's YAML files and keep
 *   the documents of their kinds. No binary is involved.
 * - `manifests` reads the directory's YAML files and keeps every document with
 *   a string `apiVersion` and `kind`, whatever the kind, so a custom resource
 *   with no lexicon class is a node too. No binary is involved. A directory
 *   that a kustomization in the workspace lists in `resources` is not read:
 *   the kustomize member has its objects.
 *
 * An Argo CD cluster Secret (a Secret labelled `argocd.argoproj.io/secret-type:
 * cluster`) is kept by the `argo-app` and `manifests` kinds, cut down to its
 * metadata and the `name` and `server` it registers (#5101, ./cluster-secret.ts).
 * Its other data holds the cluster's credentials, which the graph does not carry.
 *
 * A YAML file that does not parse, such as a chart template, is a warning that
 * names the file; the member's other files are still read.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { loadAll } from "js-yaml";
import type { Declarable } from "@intentius/chant/declarable";
import {
  defaultKustomizeRunner,
  KustomizeBinaryMissingError,
  KustomizeHelmDisabledError,
  KustomizeHelmRenderError,
  renderKustomizeDocuments,
  type KustomizeHelmOptions,
  type KustomizeRunner,
} from "./kustomize/render";
import { addRenderedEntity, renderedManifestEntity } from "./kustomize/rendered-entity";
import { hasMappingKey, KUSTOMIZATION_FILES } from "./manifest-files";
import { clusterSecretView, isClusterSecretDocument } from "./cluster-secret";
import { kustomizationDocument, readHelmReferences } from "./helm-references";

export type K8sMemberKind = "kustomize" | "argo-app" | "flux-kustomization" | "manifests";

export interface K8sMemberConfig {
  kind: K8sMemberKind;
  dir: string;
  label?: string;
  /** Kustomize only: pass `--enable-helm` (#5112). Also set by `CHANT_K8S_ENABLE_HELM=1` in the environment, which is how `chant workspace graph` is told, since it writes this config itself. */
  enableHelm?: boolean;
  /** Kustomize only: the `helm` binary for `--helm-command`. Environment: `CHANT_K8S_HELM_COMMAND`. */
  helmCommand?: string;
  /** Kustomize only: let kustomize pull a chart that is not in the chart home, which uses the network. Environment: `CHANT_K8S_FETCH_CHARTS=1`. */
  fetchCharts?: boolean;
  /** The workspace root, absolute. `manifests` uses it to find the kustomizations that list its directory, and every kind reads the values files a chart reference names from it (#5100). */
  workspace?: string;
}

/** What one member's read found, carried on the graph's `meta.k8sMember`. */
export interface K8sMemberReport {
  kind: K8sMemberKind;
  /** Kustomize only: false when the render could not run. */
  rendered?: boolean;
  /** Why nothing was read; set with `rendered: false`, or with `coveredBy`. */
  reason?: string;
  /** `manifests` only: the kustomization directory (workspace-relative) that lists this directory in `resources`, so its objects are read there. */
  coveredBy?: string;
  /** The objects the member contributed. */
  objects: number;
}

/** The apiVersion group and kinds each manifest kind is made of. */
const MANIFEST_KINDS: Record<"argo-app" | "flux-kustomization", { group: string; kinds: string[] }> = {
  "argo-app": { group: "argoproj.io", kinds: ["Application", "ApplicationSet", "AppProject"] },
  "flux-kustomization": { group: "kustomize.toolkit.fluxcd.io", kinds: ["Kustomization"] },
};

function objectDocuments(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const doc of loadAll(text)) {
    if (doc && typeof doc === "object" && !Array.isArray(doc)) out.push(doc as Record<string, unknown>);
  }
  return out;
}

/** The documents of a manifest member's YAML files directly in `dir`, in file-name order, and a warning for each file that does not parse. */
function manifestDocuments(dir: string, kind: Exclude<K8sMemberKind, "kustomize">, label: string): { docs: Array<Record<string, unknown>>; warnings: string[] } {
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  const docs: Array<Record<string, unknown>> = [];
  const warnings: string[] = [];
  for (const file of files) {
    let found: Array<Record<string, unknown>>;
    try {
      found = objectDocuments(readFileSync(join(dir, file), "utf-8"));
    } catch (err) {
      const reason = (err instanceof Error ? err.message : String(err)).split("\n")[0];
      warnings.push(`${kind} member "${label}": ${file} is not valid YAML and was skipped (${reason})`);
      continue;
    }
    // `name: {{ .Values.x }}` is a valid YAML flow mapping, with a mapping for a key, so a template line like it parses. No plain manifest has one.
    if (found.some(hasMappingKey)) {
      warnings.push(`${kind} member "${label}": ${file} holds template syntax ({{ ... }}) and was skipped`);
      continue;
    }
    for (const doc of found) {
      if (typeof doc.apiVersion !== "string" || typeof doc.kind !== "string") continue;
      // A cluster Secret registers a cluster with Argo CD, so the Argo member reads it too, cut down to its name and server.
      if (isClusterSecretDocument(doc)) {
        if (kind === "manifests" || kind === "argo-app") docs.push(clusterSecretView(doc));
        continue;
      }
      if (kind === "manifests") {
        docs.push(doc);
        continue;
      }
      const want = MANIFEST_KINDS[kind];
      if (doc.apiVersion.startsWith(`${want.group}/`) && want.kinds.includes(doc.kind)) docs.push(doc);
    }
  }
  return { docs, warnings };
}

const SCAN_SKIP = new Set(["node_modules", ".git"]);

/** Directories each kustomization under `root` lists in `resources` (or `bases`), absolute, mapped to the kustomization's directory. One scan per root per process. */
const listedCache = new Map<string, Map<string, string>>();

function listedDirectories(root: string): Map<string, string> {
  const cached = listedCache.get(root);
  if (cached) return cached;
  const listed = new Map<string, string>();
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const file = entries.find((e) => e.isFile() && KUSTOMIZATION_FILES.includes(e.name));
    if (file) {
      try {
        const doc = loadAll(readFileSync(join(dir, file.name), "utf-8"))[0] as { resources?: unknown; bases?: unknown } | undefined;
        for (const list of [doc?.resources, doc?.bases]) {
          if (!Array.isArray(list)) continue;
          for (const entry of list) {
            if (typeof entry !== "string" || /^[a-z][a-z0-9+.-]*:/i.test(entry)) continue;
            const target = resolve(dir, entry);
            if (!listed.has(target) && existsSync(target) && statSync(target).isDirectory()) listed.set(target, dir);
          }
        }
      } catch {
        // A kustomization that does not parse lists nothing here; its own member reports it.
      }
    }
    for (const e of entries) if (e.isDirectory() && !SCAN_SKIP.has(e.name)) walk(join(dir, e.name));
  };
  walk(root);
  listedCache.set(root, listed);
  return listed;
}

const truthy = (v: string | undefined): boolean => v !== undefined && /^(1|true|yes)$/i.test(v.trim());

/** The Helm settings of a kustomize member: its config, or the environment when the config sets none. */
export function memberHelmOptions(member: K8sMemberConfig, env: NodeJS.ProcessEnv = process.env): KustomizeHelmOptions {
  return {
    enableHelm: member.enableHelm ?? truthy(env.CHANT_K8S_ENABLE_HELM),
    helmCommand: member.helmCommand ?? (env.CHANT_K8S_HELM_COMMAND || undefined),
    fetchCharts: member.fetchCharts ?? truthy(env.CHANT_K8S_FETCH_CHARTS),
  };
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
      documents = await renderKustomizeDocuments(member.dir, opts.run ?? defaultKustomizeRunner, memberHelmOptions(member));
      rendered = true;
    } catch (err) {
      // A render Helm kept from happening leaves the member unrendered, not lost: the chart and values nodes read as data below still stand.
      if (!(err instanceof KustomizeBinaryMissingError || err instanceof KustomizeHelmDisabledError || err instanceof KustomizeHelmRenderError)) throw err;
      documents = [];
      rendered = false;
      reason = err.message;
      warnings.push(`kustomize member "${label}" was not rendered: ${err.message}`);
    }
  } else {
    const listedBy = member.kind === "manifests" && member.workspace ? listedDirectories(resolve(member.workspace)).get(resolve(member.dir)) : undefined;
    if (listedBy) {
      const coveredBy = relative(resolve(member.workspace!), listedBy) || ".";
      return {
        entities,
        warnings,
        report: { kind: member.kind, reason: `listed in resources by the kustomization in ${coveredBy}; its objects are read there`, coveredBy, objects: 0 },
      };
    }
    const read = manifestDocuments(member.dir, member.kind, label);
    documents = read.docs;
    warnings.push(...read.warnings);
  }

  // Charts and values files, read as data (#5100), whether or not the member rendered.
  if (member.kind === "kustomize") {
    const own = kustomizationDocument(member.dir, label);
    if (own) documents = [own, ...documents];
  }
  documents = readHelmReferences({
    documents,
    ctx: { workspace: resolve(member.workspace ?? member.dir), dir: resolve(member.dir) },
    label,
    entities,
    warnings,
    memberKind: member.kind,
  });

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
