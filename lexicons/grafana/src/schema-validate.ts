/**
 * Validate built Grafana JSON against the vendored schemas at
 * `GRAFANA_SCHEMA_PIN`, offline.
 *
 * The dashboard is checked against the dashboard schema as it stands. Panel
 * options, `fieldConfig.defaults.custom` and each query are checked against
 * their plugin's schema with every `required` list removed, because Grafana
 * fills in options a panel leaves out: what still fails is a key the schema
 * doesn't have or a value it doesn't allow.
 */

import Ajv, { type ValidateFunction, type ErrorObject } from "ajv";
import type { SchemaName } from "./pin";
import { loadSchema } from "./spec/schemas";
import { panelDefinitionFor } from "./panels";
import { queryDefinitionFor } from "./query";

export interface SchemaProblem {
  /** JSON pointer into the dashboard. */
  path: string;
  message: string;
}

let ajv: Ajv | undefined;
function getAjv(): Ajv {
  ajv ??= new Ajv({ strict: false, allErrors: true, validateFormats: false });
  return ajv;
}

const compiled = new Map<string, ValidateFunction>();

function stripRequired(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripRequired);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "required" && Array.isArray(v)) continue;
      out[k] = stripRequired(v);
    }
    return out;
  }
  return node;
}

/** A validator for one definition of one vendored schema (the root `$ref` when `def` is left out). */
function validatorFor(name: SchemaName, def: string | undefined, lenient: boolean): ValidateFunction | undefined {
  const key = `${name}#${def ?? ""}#${lenient}`;
  const hit = compiled.get(key);
  if (hit) return hit;
  const schema = loadSchema(name);
  const definitions = (schema.definitions ?? {}) as Record<string, unknown>;
  const ref = def ? `#/definitions/${def}` : (schema.$ref as string | undefined);
  if (!ref) return undefined;
  if (def && !(def in definitions)) return undefined;
  const root: Record<string, unknown> = {
    $schema: schema.$schema,
    $ref: ref,
    definitions: lenient ? stripRequired(definitions) : definitions,
  };
  const fn = getAjv().compile(root);
  compiled.set(key, fn);
  return fn;
}

function problems(errors: ErrorObject[] | null | undefined, prefix: string): SchemaProblem[] {
  const seen = new Set<string>();
  const out: SchemaProblem[] = [];
  for (const e of errors ?? []) {
    // oneOf/anyOf wrappers repeat what their branches already said.
    if (e.keyword === "oneOf" || e.keyword === "anyOf" || e.keyword === "if") continue;
    const extra =
      e.keyword === "additionalProperties"
        ? ` ("${(e.params as { additionalProperty: string }).additionalProperty}")`
        : e.keyword === "enum"
          ? `: ${(e.params as { allowedValues: unknown[] }).allowedValues.map((v) => JSON.stringify(v)).join(", ")}`
          : "";
    const path = `${prefix}${e.instancePath}` || "/";
    const message = `${e.message ?? "is invalid"}${extra}`;
    const k = `${path} ${message}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ path, message });
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

/** Everything in one dashboard that the pinned schemas reject. */
export function validateDashboardSchema(dashboard: Json): SchemaProblem[] {
  const out: SchemaProblem[] = [];
  // The envelope and each panel are checked separately: the schema's
  // `oneOf [Panel, RowPanel]` would otherwise report every panel error twice,
  // once per branch.
  const whole = validatorFor("dashboard", undefined, false)!;
  const envelope = Array.isArray(dashboard.panels) ? { ...dashboard, panels: [] } : dashboard;
  if (!whole(envelope)) out.push(...problems(whole.errors, ""));
  const panelSchema = validatorFor("dashboard", "Panel", false)!;
  const rowSchema = validatorFor("dashboard", "RowPanel", false)!;

  for (const { panel, path } of panelsOf(dashboard)) {
    if (!panel || typeof panel !== "object") {
      out.push({ path, message: "must be object" });
      continue;
    }
    if (panel.type === "row") {
      const header = Array.isArray(panel.panels) ? { ...panel, panels: [] } : panel;
      if (!rowSchema(header)) out.push(...problems(rowSchema.errors, path));
      continue;
    }
    if (!panelSchema(panel)) out.push(...problems(panelSchema.errors, path));
    const def = typeof panel.type === "string" ? panelDefinitionFor(panel.type) : undefined;
    if (def?.schema) {
      const options = validatorFor(def.schema, "Options", true);
      if (options && panel.options !== undefined && !options(panel.options)) out.push(...problems(options.errors, `${path}/options`));
      const custom = (panel.fieldConfig as { defaults?: { custom?: unknown } } | undefined)?.defaults?.custom;
      const fc = validatorFor(def.schema, "FieldConfig", true);
      if (fc && custom !== undefined && !fc(custom)) out.push(...problems(fc.errors, `${path}/fieldConfig/defaults/custom`));
    }
    const panelType = (panel.datasource as { type?: string } | undefined)?.type;
    const targets = Array.isArray(panel.targets) ? (panel.targets as Json[]) : [];
    targets.forEach((t, k) => {
      const type = (t?.datasource as { type?: string } | undefined)?.type ?? panelType;
      const qdef = type ? queryDefinitionFor(type) : undefined;
      if (!qdef?.schema) return;
      const v = validatorFor(qdef.schema, undefined, true);
      if (v && !v(t)) out.push(...problems(v.errors, `${path}/targets/${k}`));
    });
  }
  return out;
}
