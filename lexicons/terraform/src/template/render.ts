/**
 * A template request as Terraform files (#4652, epic #4642): a new root for
 * an app, or one more module call in an app's root for an add-on.
 *
 * {@link renderAppRoot} writes `main.tf` with one `module "app"` block. Its
 * `source` is the template's registry address and its `version` is the
 * requested version, pinned exactly (`version = "1.2.0"`), which is the form
 * the pin editor (`../pin/edit.ts`) reads and moves, so a rollout finds the
 * app. The module's outputs are re-exported as `app_<output>`. Day-2 actions
 * the template declares are addressed through the call, as
 * `module.app.action.<type>.<name>`, so nothing is written for them here.
 *
 * {@link renderAddonCall} writes `addon-<name>.tf` for the app's own root
 * (ruling C of #4642) with one `module "<name>"` block. An input whose value
 * is the string `app.<output>` becomes the reference `module.app.<output>`.
 *
 * Each input is written as an HCL literal of its engine-neutral kind
 * (template.yml/v1, `@intentius/chant/template-request`), in the order the
 * template lists them, with two-space indent and the `=` signs lined up as
 * `terraform fmt` lines them up. A sensitive input never travels in a
 * request: the file declares a sensitive root variable of the kind's
 * Terraform type ({@link terraformInputType}) and passes `var.<name>`, so
 * the value comes from the root's own secret store.
 *
 * The backend, provider and version files are not written here; the caller
 * writes them in the same pull request. Nothing here reads the disk, so the
 * output depends on the arguments alone: the same request gives the same
 * bytes.
 */

import { appOutputRef, inputKindProblem, inputRequired, type TemplateInput, type TemplateRequest } from "@intentius/chant/template-request";
import { escapeHcl } from "../pin/scan";
import { exactVersion } from "../pin/source";

/** The module block an app root calls its template through. Actions are addressed as `module.app.action...`. */
export const APP_MODULE_NAME = "app";

/** The prefix of the root outputs an app root re-exports its module's outputs under. */
export const APP_OUTPUT_PREFIX = "app_";

/** The file an app root's module call is written to. */
export const APP_ROOT_FILE = "main.tf";

/** The file in the app's root an add-on's module call is written to. */
export function addonFile(name: string): string {
  return `addon-${name}.tf`;
}

/** Why a request cannot be rendered. */
export type TemplateRenderErrorCode =
  | "wrong-kind"
  | "bad-name"
  | "not-a-version"
  | "unknown-input"
  | "missing-input"
  | "sensitive-input"
  | "input-type"
  | "unknown-output";

/** Thrown when a request cannot become files. `subject` names the input, output or field at fault. */
export class TemplateRenderError extends Error {
  constructor(
    public readonly code: TemplateRenderErrorCode,
    public readonly subject: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "TemplateRenderError";
  }
}

/** One output of the template's module, as the catalog's `terraform.outputs` lists it. */
export interface TemplateOutput {
  name: string;
  description?: string | null;
  sensitive?: boolean;
}

/** One file to write, its path relative to the app's root directory. */
export interface RenderedFile {
  path: string;
  text: string;
}

export interface RenderAppRootOptions {
  /** A request of kind `app`. */
  request: TemplateRequest;
  /** The template's registry address, such as `registry.example.com/acme/orders/aws`. */
  source: string;
  /** The template's inputs, from its template.yml, in the order it lists them. */
  inputs: readonly TemplateInput[];
  /** The module's outputs, each re-exported as `app_<name>`. */
  outputs?: readonly TemplateOutput[];
}

export interface RenderAddonCallOptions {
  /** A request of kind `addon`, naming the add-on in `addon`. */
  request: TemplateRequest;
  /** The add-on template's registry address. */
  source: string;
  /** The add-on template's inputs, from its template.yml, in the order it lists them. */
  inputs: readonly TemplateInput[];
  /** The outputs of the app's own module, which `app.<output>` values may name. */
  appOutputs: readonly (string | TemplateOutput)[];
}

/**
 * The Terraform type an input's kind maps to: `string`, `number`, `bool`,
 * `list(<of>)`, `map(<of>)`, and `any` for an object or for a list or map
 * whose element kind is not given (`list(any)`, `map(any)`).
 */
export function terraformInputType(input: Pick<TemplateInput, "kind" | "of">): string {
  switch (input.kind) {
    case "string":
    case "number":
    case "bool":
      return input.kind;
    case "list":
    case "map":
      return `${input.kind}(${input.of ?? "any"})`;
    case "object":
      return "any";
  }
}

// ── HCL text ──────────────────────────────────────────────────────────────

const IDENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** An expression that is already HCL: a reference or a type, written as it is. */
class RawExpr {
  constructor(public readonly raw: string) {}
}

const expr = (text: string): RawExpr => new RawExpr(text);

const isScalar = (v: unknown): boolean => v === null || typeof v !== "object" || v instanceof RawExpr;

/** Code-unit order, so the bytes never depend on a locale. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function scalar(value: unknown): string {
  if (value instanceof RawExpr) return value.raw;
  if (value === null) return "null";
  if (typeof value === "string") return `"${escapeHcl(value)}"`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw new Error(`not an HCL scalar: ${typeof value}`);
}

/** An object key: bare when it is an identifier, quoted otherwise. */
const key = (k: string): string => (IDENT.test(k) ? k : `"${escapeHcl(k)}"`);

/**
 * A JSON value as an HCL expression at `indent`. A list of scalars sits on
 * one line; a map, an object and a list holding either open one line per
 * entry. Map keys are sorted, so the order a request's JSON happened to
 * carry them in never changes the bytes.
 */
function literal(value: unknown, indent: string): string {
  if (isScalar(value)) return scalar(value);
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.every(isScalar)) return `[${value.map(scalar).join(", ")}]`;
    return `[\n${value.map((v) => `${inner}${literal(v, inner)},\n`).join("")}${indent}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort(byCodeUnit);
  if (keys.length === 0) return "{}";
  return `{\n${attributes(
    keys.map((k) => [key(k), obj[k]] as const),
    inner,
  )}${indent}}`;
}

/**
 * Attribute lines at `indent`, with the `=` of each run of one-line
 * attributes lined up, as `terraform fmt` does. An attribute whose value
 * spans lines ends the run before it and is lined up with nothing.
 */
function attributes(entries: readonly (readonly [string, unknown])[], indent: string): string {
  const rendered = entries.map(([name, value]) => ({ name, text: literal(value, indent) }));
  let out = "";
  let run: typeof rendered = [];
  const flush = () => {
    const width = Math.max(...run.map((r) => r.name.length));
    for (const r of run) out += `${indent}${r.name.padEnd(width)} = ${r.text}\n`;
    run = [];
  };
  for (const r of rendered) {
    if (r.text.includes("\n")) {
      if (run.length > 0) flush();
      run.push(r);
      flush();
    } else run.push(r);
  }
  if (run.length > 0) flush();
  return out;
}

function block(header: string, groups: readonly (readonly (readonly [string, unknown])[])[]): string {
  const body = groups
    .filter((g) => g.length > 0)
    .map((g) => attributes(g, "  "))
    .join("\n");
  return `${header} {\n${body}}\n`;
}

// ── requests ──────────────────────────────────────────────────────────────

interface Call {
  /** The module block's name. */
  name: string;
  /** The prefix of the root variables a sensitive input becomes. */
  varPrefix: string;
  /** For an add-on: the app module's outputs a value may reference. */
  appOutputs?: ReadonlySet<string>;
}

interface Argument {
  name: string;
  value: unknown;
}

interface Rendered {
  variables: string[];
  args: Argument[];
}

function checkVersion(request: TemplateRequest): string {
  const version = exactVersion(request.version);
  if (!version) {
    throw new TemplateRenderError(
      "not-a-version",
      "version",
      `the request names ${JSON.stringify(request.version)}, and a module call pins an exact version such as "1.2.0"`,
    );
  }
  return version;
}

function checkSource(source: string): void {
  if (source.length === 0 || /[\s"]/.test(source)) {
    throw new TemplateRenderError("bad-name", "source", `the source ${JSON.stringify(source)} is not a registry address`);
  }
}

/** The module arguments for each input the template lists, and a root variable for each sensitive one. */
function renderInputs(request: TemplateRequest, inputs: readonly TemplateInput[], call: Call): Rendered {
  const given = request.inputs ?? {};
  const known = new Set(inputs.map((i) => i.name));
  const extra = Object.keys(given)
    .filter((k) => !known.has(k))
    .sort(byCodeUnit);
  if (extra.length > 0) {
    throw new TemplateRenderError("unknown-input", extra[0]!, `the template has no input ${extra.map((e) => JSON.stringify(e)).join(", ")}`);
  }

  const variables: string[] = [];
  const args: Argument[] = [];
  for (const input of inputs) {
    const has = Object.prototype.hasOwnProperty.call(given, input.name);
    if (input.sensitive) {
      if (has) throw new TemplateRenderError("sensitive-input", input.name, `${input.name} is sensitive, and a request never carries a secret`);
      const variable = `${call.varPrefix}${input.name}`;
      const fields: (readonly [string, unknown])[] = [
        ["type", expr(terraformInputType(input))],
        ["sensitive", true],
      ];
      if (input.description) fields.push(["description", input.description]);
      if (!inputRequired(input)) fields.push(["default", "default" in input ? input.default : null]);
      variables.push(block(`variable "${variable}"`, [fields]));
      args.push({ name: input.name, value: expr(`var.${variable}`) });
      continue;
    }
    const value = has ? given[input.name] : input.default;
    if (value === undefined) {
      if (inputRequired(input)) throw new TemplateRenderError("missing-input", input.name, `the request gives no ${input.name}, and the input is required`);
      continue;
    }
    const output = call.appOutputs ? appOutputRef(value) : undefined;
    if (output !== undefined) {
      if (!call.appOutputs!.has(output)) {
        throw new TemplateRenderError("unknown-output", output, `${input.name} names app.${output}, and the app module has no output ${output}`);
      }
      args.push({ name: input.name, value: expr(`module.${APP_MODULE_NAME}.${output}`) });
      continue;
    }
    const problem = inputKindProblem(input, value);
    if (problem) throw new TemplateRenderError("input-type", input.name, `${input.name} ${problem}`);
    args.push({ name: input.name, value });
  }
  return { variables, args };
}

function moduleBlock(name: string, source: string, version: string, args: readonly Argument[]): string {
  return block(`module "${name}"`, [
    [
      ["source", source],
      ["version", version],
    ],
    args.map((a) => [a.name, a.value] as const),
  ]);
}

function header(request: TemplateRequest, what: string): string {
  const template = request.template.replace(/[\r\n]/g, " ");
  return `# ${what}, from the template ${template}. Written by chant from a template request; a rollout moves the version.\n`;
}

/**
 * The root of a new app: `main.tf` with one `module "app"` block calling
 * the template at the requested version, and an `app_<output>` root output
 * for each of the module's outputs. Throws {@link TemplateRenderError}.
 */
export function renderAppRoot(options: RenderAppRootOptions): RenderedFile[] {
  const { request, source, inputs, outputs = [] } = options;
  if (request.kind !== "app") throw new TemplateRenderError("wrong-kind", "kind", `the request is for an ${request.kind}, and an app root renders an app`);
  checkSource(source);
  const version = checkVersion(request);
  const { variables, args } = renderInputs(request, inputs, { name: APP_MODULE_NAME, varPrefix: `${APP_MODULE_NAME}_` });

  const parts = [header(request, `The app ${request.app}`), ...variables, moduleBlock(APP_MODULE_NAME, source, version, args)];
  for (const o of outputs) {
    if (!IDENT.test(o.name)) throw new TemplateRenderError("bad-name", o.name, `the module output ${JSON.stringify(o.name)} is not a Terraform name`);
    const fields: (readonly [string, unknown])[] = [["value", expr(`module.${APP_MODULE_NAME}.${o.name}`)]];
    if (o.description) fields.push(["description", o.description]);
    if (o.sensitive) fields.push(["sensitive", true]);
    parts.push(block(`output "${APP_OUTPUT_PREFIX}${o.name}"`, [fields]));
  }
  return [{ path: APP_ROOT_FILE, text: parts.join("\n") }];
}

/**
 * An add-on's module call for the app's root: `addon-<name>.tf` with one
 * `module "<name>"` block. A value `app.<output>` becomes
 * `module.app.<output>`, refused with `unknown-output` when the app module
 * has no such output. Throws {@link TemplateRenderError}.
 */
export function renderAddonCall(options: RenderAddonCallOptions): RenderedFile {
  const { request, source, inputs, appOutputs } = options;
  if (request.kind !== "addon") throw new TemplateRenderError("wrong-kind", "kind", `the request is for an ${request.kind}, and an add-on call renders an addon`);
  const name = request.addon;
  if (!name || !IDENT.test(name)) throw new TemplateRenderError("bad-name", "addon", `an add-on request names its add-on, as a Terraform name; it gave ${JSON.stringify(name ?? null)}`);
  if (name === APP_MODULE_NAME) throw new TemplateRenderError("bad-name", "addon", `an add-on cannot be named ${APP_MODULE_NAME}: the app's own module call has that name`);
  checkSource(source);
  const version = checkVersion(request);
  const outputs = new Set(appOutputs.map((o) => (typeof o === "string" ? o : o.name)));
  const { variables, args } = renderInputs(request, inputs, { name, varPrefix: `${name}_`, appOutputs: outputs });
  const parts = [header(request, `The add-on ${name} of the app ${request.app}`), ...variables, moduleBlock(name, source, version, args)];
  return { path: addonFile(name), text: parts.join("\n") };
}
