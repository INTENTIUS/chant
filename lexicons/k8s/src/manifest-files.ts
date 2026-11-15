/**
 * What the k8s lexicon counts as a manifest file, shared by the `manifests`
 * workspace member (./workspace-member.ts, the graph) and `chant import
 * <directory>` (./import/directory.ts), so the two read the same files.
 *
 * - A file whose objects have a mapping where a key should be, which is what
 *   `name: {{ .Values.x }}` parses to, is a chart template, not a manifest.
 * - A `kustomization.yaml` (group `kustomize.config.k8s.io`) configures a
 *   build; it declares no object of the cluster.
 */

/** The file names a directory's kustomization can have. */
export const KUSTOMIZATION_FILES = ["kustomization.yaml", "kustomization.yml", "Kustomization"];

/** Whether a mapping anywhere in `value` has a mapping for a key, which js-yaml spells "[object Object]". */
export function hasMappingKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasMappingKey);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([k, v]) => k === "[object Object]" || hasMappingKey(v));
}

/** Whether a document is a kustomize configuration (`Kustomization` or `Component`) rather than an object. */
export function isKustomizeConfig(doc: Record<string, unknown>): boolean {
  return typeof doc.apiVersion === "string" && doc.apiVersion.startsWith("kustomize.config.k8s.io/");
}
