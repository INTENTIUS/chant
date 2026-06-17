/** Edge-safe template detection for aws (CloudFormation) — see #426. */
export function detectTemplate(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  // CloudFormation has AWSTemplateFormatVersion
  if (obj.AWSTemplateFormatVersion !== undefined) return true;
  // Or Resources with AWS::* types
  if (typeof obj.Resources === "object" && obj.Resources !== null) {
    for (const resource of Object.values(obj.Resources as Record<string, unknown>)) {
      if (typeof resource === "object" && resource !== null) {
        const type = (resource as Record<string, unknown>).Type;
        if (typeof type === "string" && type.startsWith("AWS::")) {
          return true;
        }
      }
    }
  }
  return false;
}
