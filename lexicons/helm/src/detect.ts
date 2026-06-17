/** Edge-safe template detection for helm (Chart.yaml) — see #426. */
export function detectTemplate(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  // Helm charts have apiVersion: v2 in Chart.yaml
  if (obj.apiVersion === "v2" && typeof obj.name === "string" && typeof obj.version === "string") {
    return true;
  }
  return false;
}
