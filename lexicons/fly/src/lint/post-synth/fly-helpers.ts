/**
 * Shared helpers for the fly post-synth checks. Not a check itself, so the
 * generated barrel skips it (the scanner only picks up exported PostSynthChecks).
 */

/**
 * Read an entity or property's constructor props. Nested Declarables
 * (MachineConfig, MachineMount, Volume) stash their args under a non-enumerable
 * `props`; a plain inline object carries them directly. Handle both so a check
 * behaves the same whether the user authored `config: { image }` or
 * `config: new MachineConfig({ image })`.
 */
export function readProps(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") {
    const nested = (value as { props?: unknown }).props;
    if (nested && typeof nested === "object") return nested as Record<string, unknown>;
    return value as Record<string, unknown>;
  }
  return {};
}

/** The entityType of a declarable, or undefined. */
export function entityTypeOf(value: unknown): string | undefined {
  return (value as { entityType?: string } | undefined)?.entityType;
}
