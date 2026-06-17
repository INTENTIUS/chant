/** Edge-safe template detection for gcp (Config Connector) — see #426. */
export function detectTemplate(data: unknown): boolean {
  // Handle raw string input (unparsed YAML)
  if (typeof data === "string") {
    return data.includes("cnrm.cloud.google.com");
  }
  // Handle parsed YAML objects
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  const apiVersion = obj.apiVersion;
  if (typeof apiVersion === "string" && apiVersion.includes("cnrm.cloud.google.com")) {
    return true;
  }
  return false;
}
