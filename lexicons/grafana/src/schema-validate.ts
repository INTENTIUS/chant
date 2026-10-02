/**
 * Validate built Grafana JSON against the vendored schemas at
 * `GRAFANA_SCHEMA_PIN`, with the correction overlay applied, offline.
 *
 * The dashboard is checked against the dashboard schema as it stands. Panel
 * options, `fieldConfig.defaults.custom` and each query are checked against
 * their plugin's schema with every `required` list removed, because Grafana
 * fills in options a panel leaves out.
 *
 * Two kinds of problem come back. A value the schema does not allow (a
 * wrong type, an enum value it does not list, a required field missing) is
 * an error. A key the pinned schema does not know is a warning: Grafana
 * adds fields every minor release and keeps what it does not understand, so
 * an unknown key is more often a newer Grafana than a mistake. To tell the
 * two apart each value is validated twice, once with every object opened
 * (`additionalProperties: false` dropped; what fails is an error) and once
 * as pinned (what fails only for an unknown key is a warning).
 *
 * An export shared externally embeds its library panels in `__elements`;
 * each element's `model` is checked the same way as a panel on the grid.
 *
 * `oneOf` is read as `anyOf` throughout. The CUE these schemas come from
 * has disjunctions, which accept a value matching any branch; cog writes
 * them as `oneOf`, which rejects a value matching two, and loosely
 * discriminated unions (a table's `cellOptions: { type: "auto" }` matches
 * several variants) match more than one.
 */

import { createRequire } from "module";
import type AjvClass from "ajv";
import type { ValidateFunction, ErrorObject } from "ajv";
import type { SchemaName } from "./pin";
import { SCHEMA_JSON } from "./spec/schemas.gen";
import { panelDefinitionFor } from "./panels";
import { queryDefinitionFor } from "./query";

export interface SchemaProblem {
  /** JSON pointer into the dashboard. */
  path: string;
  message: string;
  /** `error` for a value the schema does not allow, `warning` for a key it does not know. */
  severity: "error" | "warning";
}

let ajv: AjvClass | undefined;
let ajvError: string | undefined;

/**
 * ajv, loaded on first use.
 *
 * Every `chant build`, `chant lint` and `chant list` loads the plugin, and the
 * plugin's post-synth barrel reaches this module, so a top-level import would
 * put ajv on every run that has grafana installed, validating or not.
 * `check()` is synchronous, so `await import()` is not available;
 * `createRequire` is (the same as the cedar lexicon's wasm, and ajv is
 * CommonJS). Where it cannot load (a bundle with no `node_modules` beside
 * it), {@link schemaValidationUnavailable} says why and GRAF107 reports that
 * instead of throwing.
 */
function getAjv(): AjvClass | undefined {
  if (ajv || ajvError) return ajv;
  try {
    const mod = createRequire(import.meta.url)("ajv") as { default?: typeof AjvClass } & typeof AjvClass;
    const Ajv = mod.default ?? mod;
    ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
  } catch (err) {
    ajvError = (err instanceof Error ? err.message : String(err)).split("\n")[0];
  }
  return ajv;
}

/** Why schema validation cannot run here (ajv did not load), or undefined when it can. */
export function schemaValidationUnavailable(): string | undefined {
  getAjv();
  return ajvError === undefined ? undefined : `ajv could not be loaded: ${ajvError}`;
}

function requireAjv(): AjvClass {
  const a = getAjv();
  if (!a) throw new Error(`grafana schema validation: ${schemaValidationUnavailable()}`);
  return a;
}

const parsed = new Map<SchemaName, Record<string, unknown>>();

/**
 * One schema as validation uses it: the vendored file with its overlay
 * applied, from the generated `spec/schemas.gen.ts` (no filesystem read, so
 * it works bundled), parsed on first use.
 */
export function bundledSchema(name: SchemaName): Record<string, unknown> {
  let schema = parsed.get(name);
  if (!schema) {
    schema = JSON.parse(SCHEMA_JSON[name]) as Record<string, unknown>;
    parsed.set(name, schema);
  }
  return schema;
}

const compiled = new Map<string, ValidateFunction>();

interface Mode {
  /** Drop every `required` list (panel options and queries: Grafana fills them in). */
  lenient: boolean;
  /** Drop every `additionalProperties: false`, so unknown keys pass. */
  open: boolean;
}

function prepare(node: unknown, mode: Mode): unknown {
  if (Array.isArray(node)) return node.map((n) => prepare(n, mode));
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (mode.lenient && k === "required" && Array.isArray(v)) continue;
      if (mode.open && k === "additionalProperties" && v === false) continue;
      out[k === "oneOf" && Array.isArray(v) ? "anyOf" : k] = prepare(v, mode);
    }
    return out;
  }
  return node;
}

/** A validator for one definition of one schema (the root `$ref` when `def` is left out). */
function validatorFor(name: SchemaName, def: string | undefined, mode: Mode): ValidateFunction | undefined {
  const key = `${name}#${def ?? ""}#${mode.lenient}#${mode.open}`;
  const hit = compiled.get(key);
  if (hit) return hit;
  const schema = bundledSchema(name);
  const definitions = (schema.definitions ?? {}) as Record<string, unknown>;
  const ref = def ? `#/definitions/${def}` : (schema.$ref as string | undefined);
  if (!ref) return undefined;
  if (def && !(def in definitions)) return undefined;
  const root: Record<string, unknown> = {
    $schema: schema.$schema,
    $ref: ref,
    definitions: prepare(definitions, mode),
  };
  const fn = requireAjv().compile(root);
  compiled.set(key, fn);
  return fn;
}

function describe(e: ErrorObject): string {
  const extra =
    e.keyword === "enum" ? `: ${(e.params as { allowedValues: unknown[] }).allowedValues.map((v) => JSON.stringify(v)).join(", ")}` : "";
  return `${e.message ?? "is invalid"}${extra}`;
}

/**
 * Everything wrong with one value against one definition: errors from the
 * opened schema, then unknown keys from the pinned one.
 */
function check(value: unknown, name: SchemaName, def: string | undefined, lenient: boolean, prefix: string): SchemaProblem[] {
  const open = validatorFor(name, def, { lenient, open: true });
  const closed = validatorFor(name, def, { lenient, open: false });
  if (!open || !closed) return [];
  const seen = new Set<string>();
  const out: SchemaProblem[] = [];
  const push = (path: string, message: string, severity: SchemaProblem["severity"]) => {
    const k = `${path} ${message}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ path, message, severity });
  };
  if (!open(value)) {
    for (const e of open.errors ?? []) {
      // anyOf/if wrappers repeat what their branches already said.
      if (e.keyword === "oneOf" || e.keyword === "anyOf" || e.keyword === "if") continue;
      push(`${prefix}${e.instancePath}` || "/", describe(e), "error");
    }
  }
  if (!closed(value)) {
    for (const e of closed.errors ?? []) {
      if (e.keyword !== "additionalProperties") continue;
      const key = (e.params as { additionalProperty: string }).additionalProperty;
      push(`${prefix}${e.instancePath}` || "/", `unknown key "${key}" (not in the pinned schema)`, "warning");
    }
  }
  return out;
}

type Json = Record<string, unknown>;

function panelsOf(dashboard: Json): Array<{ panel: Json; path: string }> {
  const out: Array<{ panel: Json; path: string }> = [];
  const top = Array.isArray(dashboard.panels) ? (dashboard.panels as Json[]) : [];
  top.forEach((p, i) => {
    out.push({ panel: p, path: `/panels/${i}` });
    if (p?.type === "row" && Array.isArray(p.panels)) {
      (p.panels as Json[]).forEach((c, j) => out.push({ panel: c, path: `/panels/${i}/panels/${j}` }));
    }
  });
  return out;
}

/** A panel (not a row) against the dashboard's Panel definition and its plugin's options, custom field config and queries. */
function checkPanel(panel: Json, path: string): SchemaProblem[] {
  const out = check(panel, "dashboard", "Panel", false, path);
  const def = typeof panel.type === "string" ? panelDefinitionFor(panel.type) : undefined;
  if (def?.schema) {
    if (panel.options !== undefined) out.push(...check(panel.options, def.schema, "Options", true, `${path}/options`));
    const custom = (panel.fieldConfig as { defaults?: { custom?: unknown } } | undefined)?.defaults?.custom;
    if (custom !== undefined) out.push(...check(custom, def.schema, "FieldConfig", true, `${path}/fieldConfig/defaults/custom`));
  }
  const panelType = (panel.datasource as { type?: string } | undefined)?.type;
  const targets = Array.isArray(panel.targets) ? (panel.targets as Json[]) : [];
  targets.forEach((t, k) => {
    const type = (t?.datasource as { type?: string } | undefined)?.type ?? panelType;
    const qdef = type ? queryDefinitionFor(type) : undefined;
    if (!qdef?.schema) return;
    out.push(...check(t, qdef.schema, undefined, true, `${path}/targets/${k}`));
  });
  return out;
}

/** `LibraryElementKind.Panel` (public/app/features/library-panels/types.ts:8-10 at v13.2.2, its only member). */
const LIBRARY_PANEL_KIND = 1;

/**
 * The library panel models an external export embeds in `__elements`. The
 * envelope check covers each element's own fields (uid, name, kind, model
 * present); the model is a whole panel, checked like one.
 */
function libraryPanelModels(dashboard: Json): Array<{ panel: Json; path: string }> {
  const elements = dashboard.__elements;
  if (!elements || typeof elements !== "object" || Array.isArray(elements)) return [];
  const out: Array<{ panel: Json; path: string }> = [];
  for (const [key, el] of Object.entries(elements as Record<string, unknown>)) {
    if (!el || typeof el !== "object") continue;
    const { kind, model } = el as { kind?: unknown; model?: unknown };
    if (kind !== undefined && kind !== LIBRARY_PANEL_KIND) continue;
    if (!model || typeof model !== "object" || Array.isArray(model)) continue;
    out.push({ panel: model as Json, path: `/__elements/${key.replace(/~/g, "~0").replace(/\//g, "~1")}/model` });
  }
  return out;
}

/** Everything in one dashboard that the pinned schemas reject or do not know. */
export function validateDashboardSchema(dashboard: Json): SchemaProblem[] {
  const out: SchemaProblem[] = [];
  // The envelope and each panel are checked separately: the schema's
  // `oneOf [Panel, RowPanel]` would otherwise report every panel error twice,
  // once per branch.
  const envelope = Array.isArray(dashboard.panels) ? { ...dashboard, panels: [] } : dashboard;
  out.push(...check(envelope, "dashboard", undefined, false, ""));

  for (const { panel, path } of panelsOf(dashboard)) {
    if (!panel || typeof panel !== "object") {
      out.push({ path, message: "must be object", severity: "error" });
      continue;
    }
    if (panel.type === "row") {
      const header = Array.isArray(panel.panels) ? { ...panel, panels: [] } : panel;
      out.push(...check(header, "dashboard", "RowPanel", false, path));
      continue;
    }
    out.push(...checkPanel(panel, path));
  }
  for (const { panel, path } of libraryPanelModels(dashboard)) out.push(...checkPanel(panel, path));
  return out;
}

/** The `expr` schema definition for each server-side expression type. */
const EXPRESSION_DEFINITIONS: Record<string, string> = {
  math: "TypeMath",
  reduce: "TypeReduce",
  resample: "TypeResample",
  classic_conditions: "TypeClassicConditions",
  threshold: "TypeThreshold",
  sql: "TypeSql",
};

/**
 * Check one server-side expression model (an alert rule's `data[].model`
 * whose datasource is `__expr__`) against the pinned `expr` schema, as
 * written: its `type` picks the definition, and every required field must
 * be there, since Grafana fills none in.
 */
export function validateExpressionSchema(model: Json, prefix = ""): SchemaProblem[] {
  const def = typeof model.type === "string" ? EXPRESSION_DEFINITIONS[model.type] : undefined;
  if (!def) {
    return [{ path: `${prefix}/type`, message: `is ${JSON.stringify(model.type)}, not one of ${Object.keys(EXPRESSION_DEFINITIONS).join(", ")}`, severity: "error" }];
  }
  return check(model, "expr", def, false, prefix);
}
