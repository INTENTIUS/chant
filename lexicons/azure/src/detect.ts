/** Edge-safe template detection for azure (ARM) — see #426. */
export function detectTemplate(content: unknown): boolean {
  if (typeof content !== "string") return false;
  try {
    const parsed = JSON.parse(content);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      "$schema" in parsed &&
      typeof parsed.$schema === "string" &&
      parsed.$schema.includes("deploymentTemplate") &&
      Array.isArray(parsed.resources)
    );
  } catch {
    return false;
  }
}
