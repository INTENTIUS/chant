/**
 * `TemplateIR` -> TypeScript, for `chant import`.
 *
 * The parser has already decided what every declaration is (./model.ts);
 * this module decides only how the plan is written, the way the lexicon's
 * examples are written:
 *
 * - one constant per declaration, named from its title (`CPU Busy` becomes
 *   `cpuBusy`; a panel's queries take its name and their refId, `cpuBusyA`);
 * - a nested value lifted into a named const typed by the class's props
 *   (`const cpuBusyOptions: PropsOf<typeof GaugePanel>["options"] = …`),
 *   which is what COR001 asks;
 * - at most eight declarables per module (COR009): a module group with
 *   more is split into `<file>-1.ts`, `<file>-2.ts`, …, keeping a panel with
 *   its queries;
 * - an `export { … }` list at the end of each module (COR004), naming what
 *   another module imports, and the dashboard;
 * - classes the plan declares (`definePanel`, `defineQuery`) in their own
 *   module, imported where they are used.
 *
 * A dashboard's modules go in a directory of their own (`plan.directory`),
 * so importing a second dashboard into the same project does not collide
 * with the first.
 *
 * Extension points:
 *
 * - `generatePlan(plan)` is the entry point for anything that builds a
 *   plan without the parser (live export, #2946).
 * - `DECLARABLES_PER_FILE` is COR009's limit.
 * - Everything Grafana-specific lives in the parser's tables
 *   (./mappings.ts); a new class needs no change here.
 */

import type { GeneratedFile, TypeScriptGenerator } from "@intentius/chant/import/generator";
import type { TemplateIR } from "@intentius/chant/import/parser";
import { isDeclRef, type CustomClass, type Declaration, type Plan } from "./model";
import { DASHBOARD_RESOURCE_TYPE, PROVISIONING_RESOURCE_TYPE, type PlanResourceProperties } from "./parser";

const PACKAGE = "@intentius/chant-lexicon-grafana";

/** COR009's default: at most this many declarables per file. */
export const DECLARABLES_PER_FILE = 8;

const MAX_LINE = 100;

const RESERVED = new Set(
  (
    "break case catch class const continue debugger default delete do else enum export extends false finally for " +
    "function if import in instanceof new null return super switch this throw true try typeof var void while with " +
    "yield let static implements interface package private protected public await arguments eval undefined NaN Infinity"
  ).split(" "),
);

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function words(text: string): string[] {
  return text.split(/[^A-Za-z0-9]+/).filter((w) => w !== "");
}

/** camelCase of a text, at most six words; an all-caps word (`DS_PROMETHEUS`) is taken as a word, not an acronym per letter. */
function camel(text: string): string {
  return words(text)
    .slice(0, 6)
    .map((w) => (w.length > 1 && w === w.toUpperCase() && /[A-Z]/.test(w) ? w.charAt(0) + w.slice(1).toLowerCase() : w))
    .map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1)))
    .join("");
}

function pascal(text: string): string {
  return words(text)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

// ── TypeScript literals ──────────────────────────────────────────────

/** An expression written as is: a reference to a declared variable. */
class Code {
  constructor(readonly code: string) {}
}

function propertyKey(k: string): string {
  return IDENT.test(k) ? k : JSON.stringify(k);
}

/**
 * A string literal: double-quoted, single-quoted when that saves escaping
 * `"` (PromQL label matchers read better), or a template literal when the
 * string spans lines.
 */
function stringLiteral(s: string): string {
  if (s.includes("\n") && !s.includes("\r")) return `\`${s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")}\``;
  const double = JSON.stringify(s);
  if (!s.includes('"') || s.includes("'")) return double;
  return `'${double.slice(1, -1).replace(/\\"/g, '"')}'`;
}

function scalarLiteral(v: unknown): string {
  if (v instanceof Code) return v.code;
  if (v === null) return "null";
  if (typeof v === "string") return stringLiteral(v);
  if (typeof v === "number") {
    if (Number.isNaN(v)) return "NaN";
    if (!Number.isFinite(v)) return v > 0 ? "Infinity" : "-Infinity";
    return Object.is(v, -0) ? "-0" : String(v);
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  return JSON.stringify(String(v));
}

function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Code);
}

function inline(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(inline).join(", ")}]`;
  if (isPlain(v)) {
    const items = Object.entries(v)
      .filter(([, x]) => x !== undefined)
      .map(([k, x]) => `${propertyKey(k)}: ${inline(x)}`);
    return items.length === 0 ? "{}" : `{ ${items.join(", ")} }`;
  }
  return scalarLiteral(v);
}

/** A value as a TypeScript expression, starting at column `col`, indented by `indent` spaces. */
export function tsLiteral(v: unknown, indent: number, col = indent): string {
  const one = inline(v);
  if (!one.includes("\n") && col + one.length + 2 <= MAX_LINE) return one;
  const pad = " ".repeat(indent + 2);
  const close = " ".repeat(indent);
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    return `[\n${v.map((x) => `${pad}${tsLiteral(x, indent + 2)},`).join("\n")}\n${close}]`;
  }
  if (isPlain(v)) {
    const lines: string[] = [];
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined) continue;
      const key = `${pad}${propertyKey(k)}: `;
      lines.push(`${key}${tsLiteral(x, indent + 2, key.length)},`);
    }
    return lines.length === 0 ? "{}" : `{\n${lines.join("\n")}\n${close}}`;
  }
  return scalarLiteral(v);
}

/** True for a value COR001 wants in a named const rather than inline in a constructor. */
function needsHoist(v: unknown): boolean {
  if (Array.isArray(v)) return v.some((x) => (typeof x === "object" && x !== null && !(x instanceof Code)) || Array.isArray(x));
  return isPlain(v);
}

// ── modules ──────────────────────────────────────────────────────────

/** One generated module: what it imports, declares and exports. */
class Module {
  readonly values = new Set<string>();
  readonly types = new Set<string>();
  readonly local = new Map<Module, Set<string>>();
  readonly body: string[] = [];
  readonly exports = new Set<string>();
  /** Names declared here, in order, so the export list follows the file. */
  readonly declared: string[] = [];
  declarables = 0;
  constructor(
    readonly path: string,
    readonly summary: string,
  ) {}

  block(lines: string[]): void {
    if (this.body.length > 0) this.body.push("");
    this.body.push(...lines);
  }

  render(): string {
    const byName = (a: string, b: string) => a.localeCompare(b, "en", { sensitivity: "base" });
    const names = [...this.values, ...[...this.types].filter((t) => !this.values.has(t)).map((t) => `type ${t}`)].sort((a, b) =>
      byName(a.replace(/^type /, ""), b.replace(/^type /, "")),
    );
    const lines = [`/** ${this.summary} */`];
    if (names.length > 0) {
      const one = `import { ${names.join(", ")} } from "${PACKAGE}";`;
      lines.push(one.length <= MAX_LINE ? one : `import {\n${names.map((n) => `  ${n},`).join("\n")}\n} from "${PACKAGE}";`);
    }
    const dir = this.path.includes("/") ? this.path.slice(0, this.path.lastIndexOf("/") + 1) : "";
    const specs = [...this.local].map(([m, set]) => [`./${m.path.slice(dir.length).replace(/\.ts$/, "")}`, set] as const);
    for (const [spec, set] of specs.sort(([a], [b]) => byName(a, b))) {
      const one = `import { ${[...set].sort(byName).join(", ")} } from "${spec}";`;
      lines.push(one.length <= MAX_LINE ? one : `import {\n${[...set].sort(byName).map((n) => `  ${n},`).join("\n")}\n} from "${spec}";`);
    }
    lines.push("", ...this.body);
    if (this.exports.size > 0) {
      const names = this.declared.filter((n) => this.exports.has(n));
      const one = `export { ${names.join(", ")} };`;
      lines.push("", one.length <= MAX_LINE ? one : `export {\n${names.map((e) => `  ${e},`).join("\n")}\n};`);
    }
    return `${lines.join("\n")}\n`;
  }
}

// ── naming ───────────────────────────────────────────────────────────

class Names {
  private readonly taken = new Set<string>();

  constructor(reserved: Iterable<string>) {
    for (const r of reserved) this.taken.add(r);
  }

  take(base: string, fallback: string): string {
    let b = camel(base);
    if (b === "" || /^[0-9]/.test(b)) b = camel(`${fallback} ${base}`);
    if (b === "" || /^[0-9]/.test(b)) b = camel(fallback);
    let out = b;
    for (let n = 2; this.taken.has(out) || RESERVED.has(out); n++) out = `${b}${n}`;
    this.taken.add(out);
    return out;
  }
}

function assignNames(plan: Plan): Map<string, string> {
  const names = new Map<string, string>();
  const classNames = plan.customClasses.map((c) => c.className);
  const namer = new Names(["PropsOf", "DatasourceRef", "definePanel", "defineQuery", ...classNames]);
  for (const d of plan.declarations) {
    if (typeof d.name === "string") names.set(d.id, namer.take(d.name, d.kind === "value" ? "datasource" : d.id.split(":")[0]));
  }
  for (const d of plan.declarations) {
    if (typeof d.name === "string") continue;
    const base = names.get(d.name.of) ?? d.name.of;
    names.set(d.id, namer.take(`${base} ${d.name.suffix}`, "query"));
  }
  return names;
}

// ── layout ───────────────────────────────────────────────────────────

/** Which file each declaration goes to: module groups split at `DECLARABLES_PER_FILE`, by unit. */
function layout(plan: Plan): { modules: Module[]; home: Map<string, Module> } {
  const modules: Module[] = [];
  const home = new Map<string, Module>();
  const prefix = plan.directory === "" ? "" : `${plan.directory}/`;

  if (plan.customClasses.length > 0) {
    const spec = plan.modules.find((m) => m.key === "plugins");
    const mod = new Module(`${prefix}${spec?.file ?? "plugins"}.ts`, spec?.summary ?? "Classes for plugins chant has no class for");
    modules.push(mod);
    for (const c of plan.customClasses) home.set(c.id, mod);
  }

  for (const spec of plan.modules) {
    if (spec.key === "plugins") continue;
    const decls = plan.declarations.filter((d) => d.module === spec.key);
    if (decls.length === 0) continue;
    // Units in declaration order, each with its declarable count.
    const units: Array<{ decls: Declaration[]; count: number }> = [];
    const byUnit = new Map<string, { decls: Declaration[]; count: number }>();
    for (const d of decls) {
      const key = d.unit ?? d.id;
      let u = byUnit.get(key);
      if (!u) {
        u = { decls: [], count: 0 };
        byUnit.set(key, u);
        units.push(u);
      }
      u.decls.push(d);
      if (d.kind === "new") u.count++;
    }
    const total = units.reduce((n, u) => n + u.count, 0);
    const chunks: Declaration[][] = [];
    if (total <= DECLARABLES_PER_FILE) chunks.push(decls);
    else {
      let current: Declaration[] = [];
      let count = 0;
      const flush = () => {
        if (current.length > 0) chunks.push(current);
        current = [];
        count = 0;
      };
      for (const u of units) {
        if (count + u.count > DECLARABLES_PER_FILE) flush();
        if (u.count > DECLARABLES_PER_FILE) {
          // A panel with more queries than fit: split the unit itself.
          for (const d of u.decls) {
            if (d.kind === "new" && count + 1 > DECLARABLES_PER_FILE) flush();
            current.push(d);
            if (d.kind === "new") count++;
          }
          continue;
        }
        current.push(...u.decls);
        count += u.count;
      }
      flush();
    }
    chunks.forEach((chunk, i) => {
      const file = chunks.length === 1 ? spec.file : `${spec.file}-${i + 1}`;
      const mod = new Module(`${prefix}${file}.ts`, chunks.length === 1 ? spec.summary : `${spec.summary} (${i + 1} of ${chunks.length})`);
      modules.push(mod);
      for (const d of chunk) home.set(d.id, mod);
    });
  }
  return { modules, home };
}

// ── generation ───────────────────────────────────────────────────────

/** The TypeScript for one plan: its modules, in the order they should be read. */
export function generatePlan(plan: Plan): GeneratedFile[] {
  return generatePlanModules(plan).files;
}

/**
 * The TypeScript for one plan, and where each declaration the plan exports
 * is declared: its module's path and variable (#2962: a ConfigMap holding
 * the dashboard refers to it).
 */
export function generatePlanModules(plan: Plan): {
  files: GeneratedFile[];
  exported: Map<string, { path: string; name: string }>;
} {
  const names = assignNames(plan);
  const { modules, home } = layout(plan);
  const byId = new Map(plan.declarations.map((d) => [d.id, d]));
  const classes = new Map(plan.customClasses.map((c) => [c.id, c]));

  const hoisted = new Set<string>([...names.values(), ...plan.customClasses.map((c) => c.className)]);
  const constName = (base: string) => {
    let out = base;
    for (let n = 2; hoisted.has(out) || RESERVED.has(out); n++) out = `${base}${n}`;
    hoisted.add(out);
    return out;
  };

  /** A reference from `mod` to a declaration or custom class, importing it when it lives elsewhere. */
  const refer = (mod: Module, id: string, name: string): Code => {
    const from = home.get(id);
    if (from && from !== mod) {
      const set = mod.local.get(from) ?? new Set<string>();
      set.add(name);
      mod.local.set(from, set);
      from.exports.add(name);
    }
    return new Code(name);
  };

  /** Replace declaration references in a value with the variables they name. */
  const resolve = (mod: Module, v: unknown): unknown => {
    if (isDeclRef(v)) {
      const target = byId.get(v.$decl);
      if (!target) throw new Error(`grafana import: the plan refers to "${v.$decl}", which it does not declare`);
      return refer(mod, v.$decl, names.get(v.$decl)!);
    }
    if (Array.isArray(v)) return v.map((x) => resolve(mod, x));
    if (isPlain(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(mod, x)]));
    return v;
  };

  // Custom classes.
  for (const c of plan.customClasses) {
    const mod = home.get(c.id)!;
    mod.values.add(c.factory);
    const head = `const ${c.className} = ${c.factory}()(`;
    mod.block([...c.comment, `${head}${tsLiteral(c.definition, 0, head.length)});`]);
    mod.declared.push(c.className);
    mod.exports.add(c.className);
  }

  for (const d of plan.declarations) {
    const mod = home.get(d.id)!;
    const name = names.get(d.id)!;
    const lines: string[] = [...(d.comment ?? [])];
    if (d.kind === "value") {
      for (const t of d.type?.imports ?? []) mod.types.add(t);
      const head = `const ${name}${d.type ? `: ${d.type.text}` : ""} = `;
      lines.push(`${head}${tsLiteral(resolve(mod, d.value), 0, head.length)};`);
    } else {
      const className = d.className!;
      let classRef: string;
      if (d.customClass) {
        const c = classes.get(d.customClass) as CustomClass;
        classRef = refer(mod, c.id, c.className).code;
      } else {
        mod.values.add(className);
        classRef = className;
      }
      mod.declarables++;
      const entries: Array<[string, string]> = [];
      for (const [key, raw] of Object.entries(d.props ?? {})) {
        if (raw === undefined) continue;
        const value = resolve(mod, raw);
        if (!needsHoist(value)) {
          entries.push([key, tsLiteral(value, 2, 4 + key.length)]);
          continue;
        }
        mod.types.add("PropsOf");
        const cn = constName(`${name}${pascal(key) || "Value"}`);
        const head = `const ${cn}: PropsOf<typeof ${classRef}>[${JSON.stringify(key)}] = `;
        lines.push(`${head}${tsLiteral(value, 0, head.length)};`);
        entries.push([key, cn]);
      }
      const head = `const ${name} = new ${classRef}(`;
      const prop = ([k, v]: [string, string]) => (k === v && IDENT.test(k) ? k : `${propertyKey(k)}: ${v}`);
      const one = `{ ${entries.map(prop).join(", ")} }`;
      const args =
        entries.length === 0
          ? "{}"
          : !one.includes("\n") && head.length + one.length + 2 <= MAX_LINE
            ? one
            : `{\n${entries.map((e) => `  ${prop(e)},`).join("\n")}\n}`;
      lines.push(`${head}${args});`);
    }
    mod.block(lines);
    mod.declared.push(name);
    if (plan.exports.includes(d.id)) mod.exports.add(name);
  }

  const exported = new Map<string, { path: string; name: string }>();
  for (const id of plan.exports) {
    const mod = home.get(id);
    const name = names.get(id);
    if (mod && name) exported.set(id, { path: mod.path, name });
  }
  return { files: modules.map((m) => ({ path: m.path, content: m.render() })), exported };
}

/** The Grafana TypeScript generator `chant import` runs. */
export class GrafanaGenerator implements TypeScriptGenerator {
  /** Core writes exactly the files returned: a dashboard's modules refer to each other and live in its own directory. */
  readonly ownsLayout = true;

  generate(ir: TemplateIR): GeneratedFile[] {
    const files: GeneratedFile[] = [];
    for (const r of ir.resources) {
      if (r.type !== DASHBOARD_RESOURCE_TYPE && r.type !== PROVISIONING_RESOURCE_TYPE) continue;
      const { plan } = r.properties as unknown as PlanResourceProperties;
      files.push(...generatePlan(plan));
    }
    // Nothing to write for a v2 or pre-5.0 dashboard: the import warnings say why.
    return files;
  }
}
