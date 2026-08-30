/**
 * Source rendering shared by constructor-shaped carve providers (#2016).
 *
 * A provider that adopts into a typed chant constructor call — aws today, gcp
 * next (#2017) — renders the same literal: an import, an exported `new Ctor({
 * ...props })`, and a reference comment carrying whatever the mapping could not
 * place. Only the lexicon import path and the property mapping differ, so the
 * rendering lives here rather than being copied per provider.
 *
 * A provider whose native shape is not a constructor call (a Kubernetes
 * manifest, #999) renders its own source and does not use this.
 */

/** The core subpath the emitted source reads build parameters from. */
export const PARAMS_IMPORT = "@intentius/chant/params";

/** Marker for a prop whose value is a `params.<name>` reference, not a literal. */
export class ParamRef {
  constructor(
    readonly name: string,
    readonly type: "string" | "number" | "boolean",
  ) {}
}

/** Render a JS object literal with stable key order and given indent. */
export function renderObject(obj: Record<string, unknown>, indent: number): string {
  const keys = Object.keys(obj);
  if (keys.length === 0) return "{}";
  const pad = " ".repeat(indent);
  const body = keys
    .map((k) => `${pad}${k}: ${renderValue(obj[k])},`)
    .join("\n");
  return `{\n${body}\n}`;
}

/** A prop value: a `params.<name>` reference (cast keeps the project tsc-clean) or a literal. */
export function renderValue(value: unknown): string {
  return value instanceof ParamRef ? `params.${value.name} as ${value.type}` : JSON.stringify(value);
}
