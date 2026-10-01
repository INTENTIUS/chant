import { CONTACT_POINT_NOTIFIERS, type NotifierOptionSchema } from "./contact-point-settings.gen";

/** The dotted paths of the options marked `secure`, through nested objects (`tlsConfig.clientKey`). */
function securePaths(options: readonly NotifierOptionSchema[], prefix = ""): string[] {
  return options.flatMap((o) => [...(o.secure ? [`${prefix}${o.key}`] : []), ...(o.options ? securePaths(o.options, `${prefix}${o.key}.`) : [])]);
}

/**
 * The contact point settings Grafana stores encrypted, per integration: the
 * options marked `secure` by `GET /api/alert-notifiers?version=2` on
 * `grafana/grafana:13.2.2` (the same list on 12.4.11), read from the table
 * `just fetch-notifiers` writes. Nested settings are dotted paths
 * (`tlsConfig.clientKey`).
 *
 * GRAF002 flags a literal at one of these paths, and the importer replaces
 * the `[REDACTED]` that an export without secrets writes there.
 */
export const CONTACT_POINT_SECRET_SETTINGS: Readonly<Record<string, readonly string[]>> = Object.freeze(
  Object.fromEntries(Object.entries(CONTACT_POINT_NOTIFIERS).map(([type, schema]) => [type, securePaths(schema.options)])),
);

/** How Grafana provisioning reads a value from outside the file: `$VAR`, `${VAR}`, `$__env{…}`, `$__file{…}`, `$__vault{…}`. */
export const EXPANDED_VALUE = /\$(\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*|__(env|file|vault)\{[^}]+\})/;

/** What an export without secrets writes in place of each one. */
export const REDACTED = "[REDACTED]";

/** The secret settings of one receiver present in `settings`, with their values: `[path, value]`. */
export function secretSettings(type: string, settings: Record<string, unknown>): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  for (const path of CONTACT_POINT_SECRET_SETTINGS[type] ?? []) {
    let node: unknown = settings;
    for (const seg of path.split(".")) node = node && typeof node === "object" ? (node as Record<string, unknown>)[seg] : undefined;
    if (node !== undefined) out.push([path, node]);
  }
  return out;
}
