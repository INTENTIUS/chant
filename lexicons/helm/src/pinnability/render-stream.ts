/**
 * Helpers over a `helm template` output stream (#1234, epic #1228).
 *
 * The CRD routing rule here is what the structure-preserving wrapper
 * (#1239) builds on, and the line diff seeds the double-render localizer
 * (#1236). Both were proven in the survey harness before promotion.
 */

/** Split a `helm template` stream into non-empty documents. */
export function splitDocuments(rendered: string): string[] {
  return rendered
    .split(/^---$/m)
    .map((d) => d.trim())
    .filter((d) => d.length > 0);
}

/** The `# Source: <chart>/<path>` origin of a rendered document, if any. */
export function sourcePath(doc: string): string | undefined {
  const m = doc.match(/^# Source: \S+?\/(\S+)$/m);
  return m ? m[1] : undefined;
}

/**
 * Finding 10: segment matching, not prefix matching. A subchart's CRDs
 * arrive as `charts/<child>/crds/<file>`; `startsWith("crds/")` catches
 * 0 of them and would route every one into templates/, making it deletable
 * on uninstall.
 */
export function isCrdSource(path: string): boolean {
  return /(^|\/)crds\//.test(path);
}

export interface RoutedDocuments {
  crds: string[];
  templates: string[];
}

/** Route rendered documents by origin: `crds/`-segment sources vs the rest. */
export function routeBySource(rendered: string): RoutedDocuments {
  const routed: RoutedDocuments = { crds: [], templates: [] };
  for (const doc of splitDocuments(rendered)) {
    const p = sourcePath(doc);
    (p !== undefined && isCrdSource(p) ? routed.crds : routed.templates).push(doc);
  }
  return routed;
}

/** Count lines that differ between two renders (symmetric, order-blind). */
export function countDifferingLines(a: string, b: string): number {
  if (a === b) return 0;
  const linesA = a.split("\n");
  const linesB = b.split("\n");
  const count = new Map<string, number>();
  for (const l of linesA) count.set(l, (count.get(l) ?? 0) + 1);
  for (const l of linesB) count.set(l, (count.get(l) ?? 0) - 1);
  let diff = 0;
  for (const n of count.values()) diff += Math.abs(n);
  return diff;
}
