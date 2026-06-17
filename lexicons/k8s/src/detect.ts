/** Edge-safe template detection for k8s — extracted from plugin.ts so it imports
 * without the lint rules (and the TypeScript compiler they pull in). See #426. */
export function detectTemplate(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  // K8s manifests have apiVersion + kind
  if (typeof obj.apiVersion === "string" && typeof obj.kind === "string") return true;
  return false;
}
