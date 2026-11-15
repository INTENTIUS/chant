/**
 * The repository paths an Argo CD Application names (#5102), for the
 * catalog's path rules: the graph looks for each in the workspace's own
 * repository and lists one that is not there as dangling. A generated
 * Application (./application-set.ts) is read the same way as one written by
 * hand.
 *
 * - `spec.source.path` and `spec.sources[].path`: a directory, from the root
 *   of the source's `repoURL`. A source that names a `chart` has no path in
 *   a repository.
 * - `helm.valueFiles[]` on either: a file. `$<ref>/<path>` is a path in the
 *   repository of the source whose `ref` is `<ref>`. Any other relative value
 *   is a path inside the source's `path`, and is read only when the source
 *   names one. A URL is not read, and a source with
 *   `helm.ignoreMissingValueFiles: true` has none read.
 *
 *   The helm rule (#5100, `helmReferences.valuesFiles[]`) owns the values
 *   files of every Application stamped with `helmReferences`, so they are
 *   not read here and a missing one is dangling once, under that rule. The
 *   k8s reader stamps an Application written by hand, and since #5094 the
 *   generate rule stamps a generated one the same way.
 *
 * A path that is absolute or climbs out of the repository's root is not
 * read. Pure.
 */
import { posix } from "node:path";
import type { IRNode } from "@intentius/chant/graph-ir";
import type { PathRule, RepoPathRef } from "@intentius/chant/graph-refs";
import { APPLICATION } from "./application-set";
import { HELM_REFERENCES_KEY } from "./helm-references";

type Doc = Record<string, unknown>;

const isObject = (v: unknown): v is Doc => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** A path from the repository's root, normalized, or undefined when it is absolute or leaves the root. */
function repoPath(path: string): string | undefined {
  if (path.startsWith("/")) return undefined;
  const norm = posix.normalize(path).replace(/\/+$/, "");
  if (norm === ".." || norm.startsWith("../")) return undefined;
  return norm === "." ? "" : norm;
}

/** The value files of one source, as repository paths. */
function valueFiles(source: Doc, sources: readonly Doc[], stamped: boolean): RepoPathRef[] {
  const helm = isObject(source.helm) ? source.helm : undefined;
  if (stamped) return [];
  if (!helm || helm.ignoreMissingValueFiles === true || !Array.isArray(helm.valueFiles)) return [];
  const out: RepoPathRef[] = [];
  for (const raw of helm.valueFiles) {
    const file = str(raw);
    if (!file || /^[a-z][a-z0-9+.-]*:\/\//i.test(file)) continue;
    if (file.startsWith("$")) {
      const slash = file.indexOf("/");
      if (slash === -1) continue;
      const ref = file.slice(1, slash);
      const repo = str(sources.find((s) => s.ref === ref)?.repoURL);
      const value = repoPath(file.slice(slash + 1));
      if (repo && value !== undefined) out.push({ value, repo, type: "file" });
      continue;
    }
    const repo = str(source.repoURL);
    const base = str(source.path);
    if (!repo || !base || source.chart !== undefined) continue;
    const value = repoPath(posix.join(base, file));
    if (value !== undefined) out.push({ value, repo, type: "file" });
  }
  return out;
}

function sourcePath(source: Doc): RepoPathRef[] {
  const repo = str(source.repoURL);
  const path = str(source.path);
  if (!repo || !path || source.chart !== undefined) return [];
  const value = repoPath(path);
  return value === undefined ? [] : [{ value, repo, type: "dir" }];
}

const specOf = (node: IRNode): Doc => (isObject(node.attrs.spec) ? node.attrs.spec : {});
const multi = (node: IRNode): Doc[] => {
  const sources = specOf(node).sources;
  return Array.isArray(sources) ? sources.filter(isObject) : [];
};
const single = (node: IRNode): Doc[] => (isObject(specOf(node).source) ? [specOf(node).source as Doc] : []);

/** Whether the k8s reader stamped the node's charts and values files for the helm rule (#5100). */
const stampedByHelm = (node: IRNode): boolean => isObject(node.attrs[HELM_REFERENCES_KEY]);

/** The path rules of an Application, one per field. */
export const applicationPathRules: PathRule[] = [
  { from: APPLICATION, path: "spec.source.path", label: "deploys from", read: (n) => single(n).flatMap(sourcePath) },
  { from: APPLICATION, path: "spec.sources[].path", label: "deploys from", read: (n) => multi(n).flatMap(sourcePath) },
  { from: APPLICATION, path: "spec.source.helm.valueFiles[]", label: "values from", read: (n) => single(n).flatMap((s) => valueFiles(s, [s], stampedByHelm(n))) },
  { from: APPLICATION, path: "spec.sources[].helm.valueFiles[]", label: "values from", read: (n) => multi(n).flatMap((s, _i, all) => valueFiles(s, all, stampedByHelm(n))) },
];
