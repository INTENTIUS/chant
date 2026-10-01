/**
 * `TemplateIR` -> TypeScript, for `chant import`.
 *
 * The parser has already decided what every declaration is (./model.ts);
 * this module decides only how the plan is written, the way the lexicon's
 * examples are written:
 *
 * - a panel, row, query or variable (property-kind, which COR001, COR004
 *   and COR009 leave out since #2957) written inline where it is used:
 *   `panels: [new TimeSeriesPanel({ ..., targets: [new PromQuery(...)] })]`,
 *   its `options` and `fieldConfig` inline too. One used in more than one
 *   place (a variable a panel repeats over) is a const instead;
 * - every other declaration a constant, named from its title (`CPU Busy`
 *   becomes `cpuBusy`; a query takes its panel's name and refId,
 *   `cpuBusyA`): the `Dashboard`, `ExternalDatasource`s, `DatasourceRef`s
 *   and a `definePanel` class's panels;
 * - a resource's nested value lifted into a named const typed by the
 *   class's props (`const overviewTime: PropsOf<typeof Dashboard>["time"] =
 *   ...`), which is what COR001 asks, and so is any value holding a call
 *   (`customTransformation(...)`), which EVL001 does not take in a
 *   constructor;
 * - one module per dashboard where COR009 allows: past eight declarables
 *   it counts, the groups holding them (the datasources) get modules of
 *   their own, split into `<file>-1.ts`, `<file>-2.ts`, ... as needed;
 *   past `LINES_PER_FILE`, each row gets one (`row-<title>.ts`), and what
 *   the rows use moves out of the dashboard's module, so no import cycles;
 * - an `export { ... }` list at the end of each module (COR004), naming what
 *   another module imports, and the dashboard;
 * - classes the plan declares (`definePanel`, `defineQuery`) ahead of the
 *   declarations that use them.
 *
 * A dashboard's modules go in a directory of their own (`plan.directory`),
 * so importing a second dashboard into the same project does not collide
 * with the first. A plan with no main group (alerting and provisioning
 * files) is written a module per group, as it always was.
 *
 * Extension points:
 *
 * - `generatePlan(plan)` is the entry point for anything that builds a
 *   plan without the parser (live export, #2946).
 * - `DECLARABLES_PER_FILE` is COR009's limit; `LINES_PER_FILE` is when a
 *   long dashboard's rows get modules of their own.
 * - A new resource class (a library panel) needs only a group in the
 *   parser's plan: being no property-kind declarable, it is written as a
 *   const, and moves to a module of its own like the datasources when the
 *   dashboard's module would hold too many.
 * - Everything Grafana-specific lives in the parser's tables
 *   (./mappings.ts); a new class needs no change here.
 */

import type { GeneratedFile, TypeScriptGenerator } from "@intentius/chant/import/generator";
import type { TemplateIR } from "@intentius/chant/import/parser";
import { isCallValue, isDeclRef, type CustomClass, type Declaration, type ModuleSpec, type Plan } from "./model";
import { DASHBOARD_RESOURCE_TYPE, PROVISIONING_RESOURCE_TYPE, type PlanResourceProperties } from "./parser";

const PACKAGE = "@intentius/chant-lexicon-grafana";

/** COR009's default: at most this many declarables per file. */
export const DECLARABLES_PER_FILE = 8;

/**
 * A dashboard longer than this in one file has its rows written to files of
 * their own. Node Exporter Full in one file would be ten thousand lines.
 */
export const LINES_PER_FILE = 1500;

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

/** A call to a package function, its arguments laid out like any other value. */
class Call {
  constructor(
    readonly fn: string,
    readonly args: readonly unknown[],
  ) {}
}

/** A property-kind declarable written where it is used: `new Class({ ... })`, its props laid out like any other value. */
class New {
  constructor(
    readonly classRef: string,
    readonly props: ReadonlyArray<readonly [string, unknown]>,
  ) {}
}

function propertyKey(k: string): string {
  return IDENT.test(k) ? k : JSON.stringify(k);
}

/** A constructor prop as written: `datasource` for `datasource: datasource`. */
function shorthand([k, v]: readonly [string, string]): string {
  return k === v && IDENT.test(k) ? k : `${propertyKey(k)}: ${v}`;
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
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Code) && !(v instanceof Call) && !(v instanceof New);
}

function inline(v: unknown): string {
  if (v instanceof Call) return `${v.fn}(${v.args.map(inline).join(", ")})`;
  if (v instanceof New) {
    const items = v.props.map(([k, x]) => (x instanceof Code ? shorthand([k, x.code]) : `${propertyKey(k)}: ${inline(x)}`));
    return `new ${v.classRef}(${items.length === 0 ? "{}" : `{ ${items.join(", ")} }`})`;
  }
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
  if (v instanceof Call && v.args.length > 0) {
    // Leading arguments that fit stay on the call's line; the last is laid out from there.
    const head = `${v.fn}(${v.args.slice(0, -1).map((a) => `${inline(a)}, `).join("")}`;
    return `${head}${tsLiteral(v.args[v.args.length - 1], indent, col + head.length)})`;
  }
  if (v instanceof New) {
    const lines = v.props.map(([k, x]) => {
      if (x instanceof Code) return `${pad}${shorthand([k, x.code])},`;
      const key = `${pad}${propertyKey(k)}: `;
      return `${key}${tsLiteral(x, indent + 2, key.length)},`;
    });
    return `new ${v.classRef}({\n${lines.join("\n")}\n${close}})`;
  }
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

/** True for a value with a call anywhere in it. */
function holdsCall(v: unknown): boolean {
  if (v instanceof Call) return true;
  if (v instanceof New) return false; // its own props were lifted already
  if (Array.isArray(v)) return v.some(holdsCall);
  return isPlain(v) && Object.values(v).some(holdsCall);
}

/** True for a value COR001 wants in a named const rather than inline in a resource's constructor; a `new` in a list is fine. */
function needsHoist(v: unknown): boolean {
  if (Array.isArray(v)) return v.some((x) => (typeof x === "object" && x !== null && !(x instanceof Code) && !(x instanceof New)) || Array.isArray(x));
  if (v instanceof Call) return true;
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
  /** The declarations written here, in order. */
  readonly decls: Declaration[] = [];
  /** How many of them COR009 counts. */
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

/** Variable names for the declarations not written inline. */
function assignNames(plan: Plan, inlined: ReadonlySet<string>): Map<string, string> {
  const names = new Map<string, string>();
  const classNames = plan.customClasses.map((c) => c.className);
  const namer = new Names(["PropsOf", "DatasourceRef", "definePanel", "defineQuery", ...classNames]);
  const byId = new Map(plan.declarations.map((d) => [d.id, d]));
  for (const d of plan.declarations) {
    if (typeof d.name === "string" && !inlined.has(d.id)) names.set(d.id, namer.take(d.name, d.kind === "value" ? "datasource" : d.id.split(":")[0]));
  }
  for (const d of plan.declarations) {
    if (typeof d.name === "string" || inlined.has(d.id)) continue;
    // A query named after a panel written inline takes the panel's title, which no variable holds.
    const of = byId.get(d.name.of)?.name;
    const base = names.get(d.name.of) ?? (typeof of === "string" ? of : d.name.of);
    names.set(d.id, namer.take(`${base} ${d.name.suffix}`, "query"));
  }
  return names;
}

// ── layout ───────────────────────────────────────────────────────────

/** True for a declaration COR009 counts: a `new` that is not property-kind. */
const counted = (d: Declaration): boolean => d.kind === "new" && d.property !== true;

/**
 * Which file each declaration goes to, and the declarations of each file in
 * the order they are written.
 *
 * A group `detached` names is written to a file of its own; the others go
 * into the file of the plan's main group, in the plan's group order (which
 * puts what is referred to before what refers to it: datasources, variables,
 * panels, rows, the dashboard). The main file imports the detached ones, so
 * a declaration one of them refers to (a variable a row's panels use) goes
 * to its group's own file instead, which keeps the imports free of cycles.
 * A plan without a main group has every group in a file of its own. A file
 * with more than `DECLARABLES_PER_FILE` declarables is split into
 * `<file>-1.ts`, `<file>-2.ts`, ..., by unit.
 */
function layout(
  plan: Plan,
  detached: (spec: ModuleSpec) => boolean,
): { modules: Module[]; home: Map<string, Module>; main?: Module; mainDeclarables: number } {
  const prefix = plan.directory === "" ? "" : `${plan.directory}/`;
  const mainSpec = plan.main === undefined ? undefined : plan.modules.find((m) => m.key === plan.main);
  const target = (spec: ModuleSpec): ModuleSpec => (mainSpec === undefined || detached(spec) ? spec : mainSpec);

  const groupOf = new Map(plan.modules.map((m) => [m.key, m]));
  const group = (d: Declaration): ModuleSpec => {
    if (!groupOf.has(d.module)) groupOf.set(d.module, { key: d.module, file: d.module, summary: d.module });
    return groupOf.get(d.module)!;
  };
  const fileOf = new Map(plan.declarations.map((d) => [d.id, target(group(d))]));
  const byId = new Map(plan.declarations.map((d) => [d.id, d]));
  for (let moved = true; moved; ) {
    moved = false;
    for (const d of plan.declarations) {
      if (fileOf.get(d.id) === mainSpec) continue;
      for (const id of referencesIn(d.kind === "value" ? d.value : d.props, [])) {
        const r = byId.get(id);
        if (r && fileOf.get(id) === mainSpec && group(r) !== mainSpec) {
          fileOf.set(id, group(r));
          moved = true;
        }
      }
    }
  }

  const pluginsSpec = groupOf.get("plugins") ?? { key: "plugins", file: "plugins", summary: "Classes for plugins chant has no class for" };
  // Classes go with the main file, unless a declaration outside it uses one.
  const outside = plan.declarations.some((d) => d.customClass !== undefined && fileOf.get(d.id) !== mainSpec);
  const pluginsTarget = outside ? pluginsSpec : target(pluginsSpec);

  // Each file's declarations, in group order: a merged group's join the main group's.
  const groups = [...new Set([pluginsSpec, ...plan.modules, ...plan.declarations.map(group)])];
  const files = new Map<ModuleSpec, Declaration[]>(groups.map((g) => [g, []]));
  for (const g of groups) for (const d of plan.declarations) if (group(d) === g) files.get(fileOf.get(d.id)!)!.push(d);

  const modules: Module[] = [];
  const home = new Map<string, Module>();
  let main: Module | undefined;
  let mainDeclarables = 0;
  for (const [spec, decls] of files) {
    const hasClasses = spec === pluginsTarget && plan.customClasses.length > 0;
    if (decls.length === 0 && !hasClasses) continue;
    const chunks = chunk(decls);
    if (spec === mainSpec) mainDeclarables = decls.filter(counted).length;
    chunks.forEach((c, i) => {
      const file = chunks.length === 1 ? spec.file : `${spec.file}-${i + 1}`;
      const mod = new Module(`${prefix}${file}.ts`, chunks.length === 1 ? spec.summary : `${spec.summary} (${i + 1} of ${chunks.length})`);
      modules.push(mod);
      if (spec === mainSpec && i === 0) main = mod;
      if (hasClasses && i === 0) for (const cls of plan.customClasses) home.set(cls.id, mod);
      for (const d of c) {
        home.set(d.id, mod);
        mod.decls.push(d);
        if (counted(d)) mod.declarables++;
      }
    });
  }
  return { modules, home, main, mainDeclarables };
}

/** A file's declarations split so that none has more than `DECLARABLES_PER_FILE` declarables, keeping each unit (a panel and its queries) together where it fits. */
function chunk(decls: Declaration[]): Declaration[][] {
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
    if (counted(d)) u.count++;
  }
  if (units.reduce((n, u) => n + u.count, 0) <= DECLARABLES_PER_FILE) return [decls];
  const chunks: Declaration[][] = [];
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
        if (counted(d) && count + 1 > DECLARABLES_PER_FILE) flush();
        current.push(d);
        if (counted(d)) count++;
      }
      continue;
    }
    current.push(...u.decls);
    count += u.count;
  }
  flush();
  return chunks;
}

/** Every declaration reference in a value, by the id it names, once per occurrence. */
function referencesIn(v: unknown, out: string[]): string[] {
  if (isDeclRef(v)) out.push(v.$decl);
  else if (isCallValue(v)) for (const a of v.args) referencesIn(a, out);
  else if (Array.isArray(v)) for (const x of v) referencesIn(x, out);
  else if (typeof v === "object" && v !== null) for (const x of Object.values(v)) referencesIn(x, out);
  return out;
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
 *
 * A plan with a main group is written as one file when that file keeps to
 * `DECLARABLES_PER_FILE` declarables and `LINES_PER_FILE` lines. Past the
 * line budget its separable groups (rows) get files of their own; past the
 * declarable limit, so does every group holding a declarable COR009 counts
 * (the `ExternalDatasource`s, a `definePanel` class's panels).
 */
export function generatePlanModules(plan: Plan): {
  files: GeneratedFile[];
  exported: Map<string, { path: string; name: string }>;
} {
  if (plan.main === undefined) return write(plan, () => true);
  const fits = (w: Written) => w.mainDeclarables <= DECLARABLES_PER_FILE;
  const one = write(plan, () => false);
  const separable = plan.modules.some((m) => m.separable === true);
  if (fits(one) && (!separable || one.mainLines <= LINES_PER_FILE)) return one;
  const rows = write(plan, (m) => m.separable === true);
  if (fits(rows)) return rows;
  return write(plan, (m) => m.separable === true || plan.declarations.some((d) => d.module === m.key && counted(d)));
}

interface Written {
  files: GeneratedFile[];
  exported: Map<string, { path: string; name: string }>;
  mainDeclarables: number;
  mainLines: number;
}

/** The plan written with the given groups in files of their own. */
function write(plan: Plan, detached: (spec: ModuleSpec) => boolean): Written {
  const { modules, home, main, mainDeclarables } = layout(plan, detached);
  const byId = new Map(plan.declarations.map((d) => [d.id, d]));
  const classes = new Map(plan.customClasses.map((c) => [c.id, c]));

  // A property-kind declaration referred to once, from its own file, is written there inline.
  const referrers = new Map<string, string[]>();
  for (const d of plan.declarations) {
    for (const id of referencesIn(d.kind === "value" ? d.value : d.props, [])) referrers.set(id, [...(referrers.get(id) ?? []), d.id]);
  }
  const inlined = new Set<string>();
  for (const d of plan.declarations) {
    const from = referrers.get(d.id) ?? [];
    if (d.kind !== "new" || d.property !== true || d.customClass !== undefined || d.comment !== undefined) continue;
    if (plan.exports.includes(d.id) || from.length !== 1 || home.get(from[0]) !== home.get(d.id)) continue;
    inlined.add(d.id);
  }

  const names = assignNames(plan, inlined);
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

  /** The class a `new` declaration constructs, as written in `mod`. */
  const classOf = (mod: Module, d: Declaration): string => {
    let ref: string;
    if (d.customClass) {
      const c = classes.get(d.customClass) as CustomClass;
      ref = refer(mod, c.id, c.className).code;
    } else {
      mod.values.add(d.className!);
      ref = d.className!;
    }
    return ref;
  };

  /** The text a declaration's lifted consts are named from: its variable, or, written inline, what that variable would be. */
  const baseName = (d: Declaration): string => {
    const named = names.get(d.id);
    if (named !== undefined) return named;
    const hint = (x: Declaration): string => (typeof x.name === "string" ? x.name : `${byId.get(x.name.of) ? hint(byId.get(x.name.of)!) : x.name.of} ${x.name.suffix}`);
    const b = camel(hint(d));
    return b === "" || /^[0-9]/.test(b) ? camel(`${d.id.split(":")[0]} ${hint(d)}`) || "value" : b;
  };

  /**
   * A `new` declaration's props as written in `mod`, each a value or a
   * lifted const. A resource's nested values are lifted (COR001); a
   * property-kind declarable's stay inline, except one holding a call
   * (`customTransformation(...)`), which EVL001 does not take inside a
   * constructor. The lifted consts are added to `pre`, ahead of the
   * declaration that uses them.
   */
  const propsOf = (mod: Module, d: Declaration, pre: string[]): Array<[string, unknown]> => {
    const typed = d.typeArguments && d.typeArguments.length > 0 ? `${classOf(mod, d)}<${d.typeArguments.join(", ")}>` : classOf(mod, d);
    const entries: Array<[string, unknown]> = [];
    for (const [key, raw] of Object.entries(d.props ?? {})) {
      if (raw === undefined) continue;
      const value = resolve(mod, raw, pre);
      if (d.property === true ? !holdsCall(value) : !needsHoist(value)) {
        entries.push([key, value]);
        continue;
      }
      mod.types.add("PropsOf");
      const cn = constName(`${baseName(d)}${pascal(key) || "Value"}`);
      const head = `const ${cn}: PropsOf<typeof ${typed}>[${JSON.stringify(key)}] = `;
      pre.push(`${head}${tsLiteral(value, 0, head.length)};`);
      entries.push([key, new Code(cn)]);
    }
    return entries;
  };

  /** Replace declaration references in a value with the variables they name, or, for one written inline, its `new`. */
  const resolve = (mod: Module, v: unknown, pre: string[]): unknown => {
    if (isDeclRef(v)) {
      const target = byId.get(v.$decl);
      if (!target) throw new Error(`grafana import: the plan refers to "${v.$decl}", which it does not declare`);
      if (inlined.has(target.id)) return new New(classOf(mod, target), propsOf(mod, target, pre));
      return refer(mod, v.$decl, names.get(v.$decl)!);
    }
    if (isCallValue(v)) {
      mod.values.add(v.$call);
      return new Call(v.$call, v.args.map((x) => resolve(mod, x, pre)));
    }
    if (Array.isArray(v)) return v.map((x) => resolve(mod, x, pre));
    if (isPlain(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(mod, x, pre)]));
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

  for (const mod of modules) {
    for (const d of mod.decls) {
      if (inlined.has(d.id)) continue;
      const name = names.get(d.id)!;
      const lines: string[] = [...(d.comment ?? [])];
      if (d.kind === "value") {
        for (const t of d.type?.imports ?? []) mod.types.add(t);
        const head = `const ${name}${d.type ? `: ${d.type.text}` : ""} = `;
        lines.push(`${head}${tsLiteral(resolve(mod, d.value, lines), 0, head.length)};`);
      } else {
        const classRef = classOf(mod, d);
        const entries: Array<[string, string]> = propsOf(mod, d, lines).map(([key, value]) => [
          key,
          value instanceof Code ? value.code : tsLiteral(value, 2, 4 + key.length),
        ]);
        const head = `const ${name} = new ${classRef}(`;
        const one = `{ ${entries.map(shorthand).join(", ")} }`;
        const args =
          entries.length === 0
            ? "{}"
            : !one.includes("\n") && head.length + one.length + 2 <= MAX_LINE
              ? one
              : `{\n${entries.map((e) => `  ${shorthand(e)},`).join("\n")}\n}`;
        lines.push(`${head}${args});`);
      }
      mod.block(lines);
      mod.declared.push(name);
      if (plan.exports.includes(d.id)) mod.exports.add(name);
    }
  }

  const exported = new Map<string, { path: string; name: string }>();
  for (const id of plan.exports) {
    const mod = home.get(id);
    const name = names.get(id);
    if (mod && name) exported.set(id, { path: mod.path, name });
  }
  const files = modules.map((m) => ({ path: m.path, content: m.render() }));
  const mainFile = main === undefined ? undefined : files[modules.indexOf(main)];
  return { files, exported, mainDeclarables, mainLines: mainFile === undefined ? 0 : mainFile.content.split("\n").length - 1 };
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
