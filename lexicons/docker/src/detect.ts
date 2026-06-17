/** Edge-safe template detection for docker (Compose) — see #426. */
export function detectTemplate(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  // Docker Compose files have a services: key
  return "services" in obj;
}
