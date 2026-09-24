/**
 * Template parameters (#2627, #2524 D9): `chant.template.json` at a
 * template's root declares the parameters `chant init --from` takes and the
 * files they are substituted into.
 *
 * ```json
 * {
 *   "parameters": {
 *     "name": { "type": "string", "default": "Reference app", "pattern": "^[A-Za-z0-9][A-Za-z0-9 ._-]*$" }
 *   },
 *   "files": ["app/src/server.mjs"]
 * }
 * ```
 *
 * A listed file carries `{{chant:<name>}}` where the value goes. The `chant:`
 * prefix keeps the placeholder apart from TypeScript template literals
 * (`${x}`), GitHub and Forgejo expressions (`${{ x }}`) and Handlebars or
 * Mustache (`{{x}}`), so a template can hold any of those in a listed file.
 * Only listed files are substituted, the value is inserted as written, and a
 * placeholder naming an undeclared parameter is an error in the template.
 *
 * The manifest is JSON and read as data: no template code runs at init or
 * upgrade. It is template metadata, like `.chant/migrations/`, so it is not
 * copied into the project. The values used are recorded in the lineage's
 * `parameters`, and `chant workspace upgrade` substitutes them again into both
 * the merge base and the target version, so an unedited file carrying a value
 * still has its recorded hash.
 *
 * `hostBound` is declared and validated but not acted on yet: recording a
 * value per host belongs to export and import (#2552). A host-bound value is
 * recorded in `parameters` like any other until then.
 */

import { posix } from "node:path";
import { z } from "zod";
import { LockError } from "./lineage-lock";
import { MIGRATIONS_DIR } from "./lineage-migrations";

/** The manifest's path, relative to the template's root (the `#<member>` directory, when one is given). */
export const TEMPLATE_MANIFEST = "chant.template.json";

const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `{{chant:<name>}}`. */
const PLACEHOLDER = /\{\{chant:([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

export function placeholder(name: string): string {
  return `{{chant:${name}}}`;
}

const ParameterSchema = z
  .object({
    type: z.literal("string"),
    default: z.string().optional(),
    /** A regular expression every value must match, checked before substitution. */
    pattern: z.string().optional(),
    /** The value differs per host (#2524 D9). Recorded per host once #2552 lands. */
    hostBound: z.boolean().optional(),
    description: z.string().optional(),
  })
  .strict();
export type TemplateParameter = z.infer<typeof ParameterSchema>;

const ManifestSchema = z
  .object({
    $comment: z.string().optional(),
    parameters: z.record(z.string(), ParameterSchema),
    files: z.array(z.string().min(1)),
  })
  .strict();
export type TemplateManifest = z.infer<typeof ManifestSchema>;

function has(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

export class TemplateParameterError extends LockError {
  override name = "TemplateParameterError";
}

/**
 * Read the manifest from a template's files, or null when it has none.
 * Throws on a manifest that is not valid JSON or does not match the schema.
 */
export function readManifest(files: Map<string, Buffer>): TemplateManifest | null {
  const data = files.get(TEMPLATE_MANIFEST);
  if (!data) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(data.toString("utf-8"));
  } catch (err) {
    throw new TemplateParameterError(`${TEMPLATE_MANIFEST} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new TemplateParameterError(
      `invalid ${TEMPLATE_MANIFEST}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
    );
  }
  const manifest = parsed.data;
  for (const [name, p] of Object.entries(manifest.parameters)) {
    if (!PARAM_NAME.test(name)) {
      throw new TemplateParameterError(`invalid ${TEMPLATE_MANIFEST}: parameter name "${name}" is not a letter or _ followed by letters, digits or _`);
    }
    if (p.pattern !== undefined) {
      try {
        new RegExp(p.pattern, "u");
      } catch {
        throw new TemplateParameterError(`invalid ${TEMPLATE_MANIFEST}: parameters.${name}.pattern is not a regular expression`);
      }
      if (p.default !== undefined) checkValue(name, p, p.default, "its default");
    }
  }
  for (const f of manifest.files) {
    const norm = posix.normalize(f);
    if (norm !== f || f.startsWith("/") || f.startsWith("../") || f === TEMPLATE_MANIFEST || f.startsWith(`${MIGRATIONS_DIR}/`)) {
      throw new TemplateParameterError(`invalid ${TEMPLATE_MANIFEST}: files lists "${f}", which is not a normalised path to a template file`);
    }
  }
  return manifest;
}

function checkValue(name: string, p: TemplateParameter, value: string, what: string): void {
  if (p.pattern !== undefined && !new RegExp(p.pattern, "u").test(value)) {
    throw new TemplateParameterError(`parameter ${name}: ${what} ${JSON.stringify(value)} does not match ${p.pattern}`);
  }
}

/**
 * Parse `--param name=value` arguments (split at the first `=`). A name given
 * twice is refused rather than silently taking the last value.
 */
export function parseParamArgs(args: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arg of args) {
    const eq = arg.indexOf("=");
    if (eq <= 0) throw new TemplateParameterError(`--param ${arg}: expected <name>=<value>`);
    const name = arg.slice(0, eq);
    if (has(out, name)) throw new TemplateParameterError(`--param ${name} is given twice`);
    out[name] = arg.slice(eq + 1);
  }
  return out;
}

function declaredList(manifest: TemplateManifest | null): string {
  const names = manifest ? Object.keys(manifest.parameters).sort() : [];
  return names.length > 0 ? `declared: ${names.join(", ")}` : "the template declares none";
}

/**
 * The value of every declared parameter: the given value, or the default.
 * Refuses an undeclared name (listing the declared ones), a parameter with no
 * value and no default, and a value that does not match its pattern.
 */
export function resolveParameters(manifest: TemplateManifest | null, given: Record<string, string>): Record<string, string> {
  const declared = manifest?.parameters ?? {};
  const unknown = Object.keys(given).filter((n) => !has(declared, n)).sort();
  if (unknown.length > 0) {
    throw new TemplateParameterError(`unknown parameter${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")} (${declaredList(manifest)})`);
  }
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of Object.keys(declared).sort()) {
    const p = declared[name];
    const value = has(given, name) ? given[name] : p.default;
    if (value === undefined) {
      missing.push(name);
      continue;
    }
    checkValue(name, p, value, has(given, name) ? "the value" : "its default");
    values[name] = value;
  }
  if (missing.length > 0) {
    throw new TemplateParameterError(
      `parameter${missing.length > 1 ? "s" : ""} ${missing.join(", ")} ${missing.length > 1 ? "have" : "has"} no default; pass ${missing.map((n) => `--param ${n}=<value>`).join(" ")}`,
    );
  }
  return values;
}

/**
 * The template's files as the project gets them: the manifest removed, and
 * each listed file with its placeholders replaced. A listed file that is
 * missing, or a placeholder naming no declared parameter, is refused.
 */
export function substituteParameters(
  files: Map<string, Buffer>,
  manifest: TemplateManifest | null,
  values: Record<string, string>,
): Map<string, Buffer> {
  const out = new Map(files);
  out.delete(TEMPLATE_MANIFEST);
  if (!manifest) return out;
  for (const path of manifest.files) {
    const data = out.get(path);
    if (!data) throw new TemplateParameterError(`${TEMPLATE_MANIFEST} lists ${path}, which is not in the template`);
    const text = data.toString("utf-8");
    const replaced = text.replace(PLACEHOLDER, (_m, name: string) => {
      if (!has(values, name)) {
        throw new TemplateParameterError(`${path} has ${placeholder(name)}, but ${TEMPLATE_MANIFEST} declares no parameter ${name}`);
      }
      return values[name];
    });
    if (replaced !== text) out.set(path, Buffer.from(replaced, "utf-8"));
  }
  return out;
}

/**
 * The values an upgrade substitutes into a version of the template: the
 * recorded value of every parameter that version declares, and the default of
 * one it adds. A recorded parameter the version no longer declares is dropped.
 */
export function carryParameters(manifest: TemplateManifest | null, recorded: Record<string, unknown>): Record<string, string> {
  const declared = manifest?.parameters ?? {};
  const given: Record<string, string> = {};
  for (const [name, value] of Object.entries(recorded)) {
    if (has(declared, name) && typeof value === "string") given[name] = value;
  }
  return resolveParameters(manifest, given);
}
