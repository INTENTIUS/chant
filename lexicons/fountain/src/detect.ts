/**
 * Detection helpers — is this input a fountain artifact?
 */

const KINDS = new Set(["Environment", "Vault", "Agent"]);

/** A fountain manifest document (parsed): apiVersion fountain.dev/v1 + known kind. */
export function isFountainManifest(doc: unknown): boolean {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return false;
  const d = doc as Record<string, unknown>;
  return d.apiVersion === "fountain.dev/v1" && typeof d.kind === "string" && KINDS.has(d.kind);
}

/** The serializer's fountain-plan.json shape: entity name → { kind, spec }. */
export function isFountainPlan(data: unknown): boolean {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const entries = Object.values(data as Record<string, unknown>);
  if (entries.length === 0) return false;
  return entries.every((e) => {
    if (!e || typeof e !== "object") return false;
    const entry = e as Record<string, unknown>;
    return typeof entry.kind === "string" && KINDS.has(entry.kind) && typeof entry.spec === "object";
  });
}

/**
 * Canonical `detectTemplate` name under `@…/detect` — what edge callers
 * (and core's detect-bundle guard) import for content detection.
 */
export { detectFountainTemplate as detectTemplate };

/** Template detection for the plugin: raw string input (YAML or JSON). */
export function detectFountainTemplate(data: unknown): boolean {
  if (typeof data === "string") {
    if (/apiVersion:\s*fountain\.dev\/v1/.test(data)) return true;
    try {
      return isFountainPlan(JSON.parse(data));
    } catch {
      return false;
    }
  }
  return isFountainManifest(data) || isFountainPlan(data);
}
