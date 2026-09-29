/**
 * `TemplateIR` -> TypeScript, for `chant import`.
 *
 * Writes the files the way the lexicon's examples are written: nested
 * settings lifted into named consts typed by the model (COR001), at most
 * eight declarables per module (COR009), and an `export { ... }` list at the
 * end of each module (COR004 flags an exported declaration nothing in its
 * file uses).
 *
 * A rule file becomes `rules.ts`: per group, its rules as a `Rule[]` const
 * of plain objects, the same shape `ruleGroupConfig` emits, and a
 * `RuleGroup`. A group an `Slo()` built is written as that `Slo` call in
 * `slos.ts` instead (see ./slo.ts).
 *
 * An `alertmanager.yml` becomes `receivers.ts`, `time-intervals.ts`,
 * `routes.ts` (the root `Route`, its children as `RouteProps` objects),
 * `inhibit-rules.ts` and `settings.ts`. Routes name their receivers and time
 * intervals by the declared variable, imported from the module that
 * declares it; a name nothing declares stays a string, and PROM201 / PROM204
 * report it.
 */

import type { GeneratedFile, TypeScriptGenerator } from "@intentius/chant/import/generator";
import type { TemplateIR } from "@intentius/chant/import/parser";
import type {
  AlertmanagerConfig,
  InhibitRuleConfig,
  ReceiverConfig,
  RouteConfig,
  RuleFileConfig,
  RuleGroupConfig,
  TimeIntervalConfig,
} from "../model";
import { ALERTMANAGER_GLOBAL_FIELDS, RECEIVER_INTEGRATION_TYPES } from "../model";
import { PROMETHEUS_PIN } from "../pin";
import {
  ALERTMANAGER_RESOURCE_TYPE,
  RULE_FILE_RESOURCE_TYPE,
  type AlertmanagerResourceProperties,
  type RuleFileResourceProperties,
} from "./parser";
import { recognizeSlo } from "./slo";

const PACKAGE = "@intentius/chant-lexicon-prometheus";

const RESERVED = new Set(
  (
    "break case catch class const continue debugger default delete do else enum export extends false finally for " +
    "function if import in instanceof new null return super switch this throw true try typeof var void while with " +
    "yield let static implements interface package private protected public await arguments eval undefined"
  ).split(" "),
);

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function words(text: string): string[] {
  return text.split(/[^A-Za-z0-9]+/).filter((w) => w !== "");
}

function camel(text: string): string {
  return words(text)
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

const MAX_LINE = 100;

function propertyKey(k: string): string {
  return IDENT.test(k) ? k : JSON.stringify(k);
}

/**
 * A string literal: double-quoted, single-quoted when that saves escaping
 * `"` (PromQL label matchers read better), or a template literal when the
 * string spans lines, as a multi-line `expr: |` does.
 */
function stringLiteral(s: string): string {
  if (s.includes("\n")) return `\`${s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")}\``;
  const double = JSON.stringify(s);
  if (!s.includes('"') || s.includes("'")) return double;
  return `'${double.slice(1, -1).replace(/\\"/g, '"')}'`;
}

function scalarLiteral(v: unknown): string {
  if (v instanceof Code) return v.code;
  if (v === null) return "null";
  if (typeof v === "string") return stringLiteral(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(String(v));
}

function inline(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(inline).join(", ")}]`;
  if (typeof v === "object" && v !== null && !(v instanceof Code)) {
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
  if (typeof v === "object" && v !== null && !(v instanceof Code)) {
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

/** An object literal whose entries are already-rendered expressions, starting at column `col`. */
function objectOf(entries: Array<[string, string]>, indent: number, col: number): string {
  if (entries.length === 0) return "{}";
  const prop = ([k, v]: [string, string]) =>
    k === v && IDENT.test(k) ? k : k.startsWith("...") ? k : `${propertyKey(k)}: ${v}`;
  const one = `{ ${entries.map(prop).join(", ")} }`;
  if (!one.includes("\n") && col + one.length + 2 <= MAX_LINE) return one;
  const pad = " ".repeat(indent + 2);
  return `{\n${entries.map((e) => `${pad}${prop(e)},`).join("\n")}\n${" ".repeat(indent)}}`;
}

/** True for a value COR001 wants in a named const rather than inline in a constructor. */
function needsHoist(v: unknown): boolean {
  if (v instanceof Code) return false;
  if (Array.isArray(v)) return v.some((x) => typeof x === "object" && x !== null && !(x instanceof Code));
  return typeof v === "object" && v !== null;
}

// ── modules ──────────────────────────────────────────────────────────

/** COR009's default: at most this many declarables per file. */
const DECLARABLES_PER_FILE = 8;

/** One generated module: what it imports, declares and exports. */
class Module {
  readonly values = new Set<string>();
  readonly types = new Set<string>();
  readonly local = new Map<string, Set<string>>();
  readonly body: string[] = [];
  readonly exports: string[] = [];
  constructor(
    readonly path: string,
    readonly summary: string,
  ) {}

  use(name: string, from?: Module): void {
    if (!from) this.values.add(name);
    else if (from !== this) {
      const spec = `./${from.path.replace(/\.ts$/, "")}`;
      const set = this.local.get(spec) ?? new Set<string>();
      set.add(name);
      this.local.set(spec, set);
    }
  }

  block(lines: string[]): void {
    if (this.body.length > 0) this.body.push("");
    this.body.push(...lines);
  }

  render(): string {
    const byName = (a: string, b: string) => a.localeCompare(b, "en", { sensitivity: "base" });
    const names = [...this.values, ...[...this.types].map((t) => `type ${t}`)].sort((a, b) =>
      byName(a.replace(/^type /, ""), b.replace(/^type /, "")),
    );
    const lines = [`/** ${this.summary} */`];
    if (names.length > 0) {
      const one = `import { ${names.join(", ")} } from "${PACKAGE}";`;
      lines.push(one.length <= MAX_LINE ? one : `import {\n${names.map((n) => `  ${n},`).join("\n")}\n} from "${PACKAGE}";`);
    }
    for (const [spec, set] of [...this.local].sort(([a], [b]) => byName(a, b))) {
      const list = [...set].sort(byName);
      const one = `import { ${list.join(", ")} } from "${spec}";`;
      lines.push(one.length <= MAX_LINE ? one : `import {\n${list.map((n) => `  ${n},`).join("\n")}\n} from "${spec}";`);
    }
    lines.push("", ...this.body);
    if (this.exports.length > 0) {
      const one = `export { ${this.exports.join(", ")} };`;
      lines.push("", one.length <= MAX_LINE ? one : `export {\n${this.exports.map((e) => `  ${e},`).join("\n")}\n};`);
    }
    return `${lines.join("\n")}\n`;
  }
}

/** Split `items` into modules of at most `DECLARABLES_PER_FILE`, named `base.ts` or `base-1.ts`, `base-2.ts`, … */
function chunk<T>(items: T[], base: string, summary: string): Array<[Module, T[]]> {
  if (items.length === 0) return [];
  if (items.length <= DECLARABLES_PER_FILE) return [[new Module(`${base}.ts`, summary), items]];
  const out: Array<[Module, T[]]> = [];
  for (let i = 0; i < items.length; i += DECLARABLES_PER_FILE) {
    out.push([new Module(`${base}-${out.length + 1}.ts`, summary), items.slice(i, i + DECLARABLES_PER_FILE)]);
  }
  return out;
}

/** Variable names, unique across every module of one import. */
class Names {
  private readonly taken = new Set<string>();
  constructor(reserved: string[]) {
    for (const r of reserved) this.taken.add(r);
  }
  /** `base`, or `base` + `suffix` when that is taken or not an identifier, then numbered. */
  claim(text: string, suffix: string, fallback: string): string {
    return this.claimWith(text, suffix, fallback, []);
  }
  /**
   * Like `claim`, and also reserves `name + member` for each member: a
   * composite's members are declared under those names.
   */
  claimWith(text: string, suffix: string, fallback: string, members: string[]): string {
    const free = (n: string) => !this.taken.has(n) && !RESERVED.has(n) && members.every((m) => !this.taken.has(`${n}${m}`));
    let base = camel(text);
    if (base === "" || /^[0-9]/.test(base)) base = camel(`${fallback} ${text}`);
    if (!free(base)) base = `${base}${suffix}`;
    let out = base;
    for (let n = 2; !free(out); n++) out = `${base}${n}`;
    this.taken.add(out);
    for (const m of members) this.taken.add(`${out}${m}`);
    return out;
  }
}

/** The lexicon's exports a generated module may import; no variable takes one of these names. */
const LEXICON_NAMES = [
  "RuleGroup",
  "Slo",
  "Rule",
  "LabelSet",
  "Route",
  "RouteProps",
  "Receiver",
  "TimeInterval",
  "TimePeriodConfig",
  "InhibitRule",
  "AlertmanagerSettings",
  "AlertmanagerGlobalConfig",
  "AlertmanagerTracingConfig",
  "WebhookConfig",
  "EmailConfig",
  "SlackConfig",
  "PagerDutyConfig",
];

// ── rule files ───────────────────────────────────────────────────────

/** Generate the TypeScript declaring one rule file. */
export function generateRuleFileFiles(file: RuleFileConfig): GeneratedFile[] {
  const names = new Names(LEXICON_NAMES);
  const slos: Array<{ group: RuleGroupConfig; props: NonNullable<ReturnType<typeof recognizeSlo>> }> = [];
  const groups: RuleGroupConfig[] = [];
  for (const g of file.groups) {
    const props = recognizeSlo(g);
    if (props) slos.push({ group: g, props });
    else groups.push(g);
  }
  // Each Slo declares its rule group as `<name>Rules`, so those names are claimed first.
  const sloVars = slos.map(({ props }) => names.claimWith(props.name, "Slo", "slo", ["Rules"]));

  const modules: Module[] = [];
  for (const [mod, items] of chunk(groups, "rules", "Rule groups")) {
    modules.push(mod);
    mod.use("RuleGroup");
    for (const g of items) {
      const v = names.claim(g.name, "Group", "group");
      const lines: string[] = [];
      const entries: Array<[string, string]> = [["name", stringLiteral(g.name)]];
      if (g.interval !== undefined) entries.push(["interval", stringLiteral(g.interval)]);
      if (g.query_offset !== undefined) entries.push(["query_offset", stringLiteral(g.query_offset)]);
      if (g.limit !== undefined) entries.push(["limit", String(g.limit)]);
      if (g.labels !== undefined) {
        mod.types.add("LabelSet");
        const c = names.claim(`${v} labels`, "", "group");
        const head = `const ${c}: LabelSet = `;
        lines.push(`${head}${tsLiteral(g.labels, 0, head.length)};`);
        entries.push(["labels", c]);
      }
      mod.types.add("Rule");
      const rulesConst = names.claim(`${v} rules`, "", "group");
      const head = `const ${rulesConst}: Rule[] = `;
      lines.push(`${head}${tsLiteral(g.rules, 0, head.length)};`);
      entries.push(["rules", rulesConst]);
      const ctor = `const ${v} = new RuleGroup(`;
      lines.push(`${ctor}${objectOf(entries, 0, ctor.length)});`);
      mod.block(lines);
      mod.exports.push(v);
    }
  }

  for (const [mod, items] of chunk(slos, "slos", "Service level objectives, each built by Slo() to its rule group")) {
    modules.push(mod);
    mod.use("Slo");
    for (const { props } of items) {
      const v = sloVars[slos.findIndex((s) => s.props === props)];
      const head = `const ${v} = Slo(`;
      mod.block([`${head}${tsLiteral(props, 0, head.length)});`]);
      mod.exports.push(v);
    }
  }

  return modules.map((m) => ({ path: m.path, content: m.render() }));
}

// ── alertmanager.yml ─────────────────────────────────────────────────

/** Receiver fields the lexicon types, with the type each list is declared as. */
const RECEIVER_FIELD_TYPES: Record<string, string> = {
  ...Object.fromEntries(Object.entries(RECEIVER_INTEGRATION_TYPES).map(([k, t]) => [k, `${t}[]`])),
  labels: "LabelSet",
};

/** `global:` fields the lexicon types. */
const GLOBAL_FIELDS = new Set<string>(ALERTMANAGER_GLOBAL_FIELDS);

const AM_VERSION = PROMETHEUS_PIN.alertmanager.version;

/** A comment naming the fields carried as data, wrapped at the line limit. */
function untypedComment(what: string, keys: string[]): string[] {
  const one = keys.length === 1;
  const text = `${what} ${keys.join(", ")} ${one ? "is not a field" : "are not fields"} Alertmanager ${AM_VERSION} defines, so ${one ? "it is" : "they are"} carried as data, untyped.`;
  const lines: string[] = [];
  let cur = "//";
  for (const w of text.split(" ")) {
    if (cur.length + 1 + w.length > MAX_LINE) {
      lines.push(cur);
      cur = "//";
    }
    cur += ` ${w}`;
  }
  lines.push(cur);
  return lines;
}

/** Generate the TypeScript declaring one `alertmanager.yml`. */
export function generateAlertmanagerFiles(config: AlertmanagerConfig): GeneratedFile[] {
  const names = new Names([...LEXICON_NAMES, "global", "tracing"]);
  const modules: Module[] = [];
  const receiverVars = new Map<string, { v: string; mod: Module }>();
  const intervalVars = new Map<string, { v: string; mod: Module }>();

  // Receivers.
  for (const [mod, items] of chunk(config.receivers ?? [], "receivers", "Receivers: where notifications go")) {
    modules.push(mod);
    mod.use("Receiver");
    for (const r of items) {
      const v = names.claim(r.name, "Receiver", "receiver");
      receiverVars.set(r.name, { v, mod });
      const lines: string[] = [];
      const entries: Array<[string, string]> = [["name", stringLiteral(r.name)]];
      const untyped: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(r as ReceiverConfig & Record<string, unknown>)) {
        if (key === "name" || value === undefined) continue;
        const type = RECEIVER_FIELD_TYPES[key];
        if (!type) {
          untyped[key] = value;
          continue;
        }
        if (!needsHoist(value)) {
          entries.push([key, tsLiteral(value, 2, 4 + key.length)]);
          continue;
        }
        mod.types.add(type.replace(/\[\]$/, ""));
        const c = names.claim(`${v} ${key.replace(/_configs$/, "")}`, "Config", "receiver");
        const head = `const ${c}: ${type} = `;
        lines.push(`${head}${tsLiteral(value, 0, head.length)};`);
        entries.push([key, c]);
      }
      if (Object.keys(untyped).length > 0) {
        const c = names.claim(`${v} untyped`, "", "receiver");
        lines.push(...untypedComment(`Receiver "${r.name}":`, Object.keys(untyped)));
        const head = `const ${c} = `;
        lines.push(`${head}${tsLiteral(untyped, 0, head.length)};`);
        entries.push([`...${c}`, c]);
      }
      const ctor = `const ${v} = new Receiver(`;
      lines.push(`${ctor}${objectOf(entries, 0, ctor.length)});`);
      mod.block(lines);
      mod.exports.push(v);
    }
  }

  // Time intervals.
  for (const [mod, items] of chunk(config.time_intervals ?? [], "time-intervals", "Time intervals routes mute or activate on")) {
    modules.push(mod);
    mod.use("TimeInterval");
    for (const t of items as TimeIntervalConfig[]) {
      const v = names.claim(t.name, "Interval", "interval");
      intervalVars.set(t.name, { v, mod });
      const lines: string[] = [];
      let periods = tsLiteral(t.time_intervals, 2, 20);
      if (needsHoist(t.time_intervals)) {
        mod.types.add("TimePeriodConfig");
        const c = names.claim(`${v} periods`, "", "interval");
        const head = `const ${c}: TimePeriodConfig[] = `;
        lines.push(`${head}${tsLiteral(t.time_intervals, 0, head.length)};`);
        periods = c;
      }
      const ctor = `const ${v} = new TimeInterval(`;
      lines.push(`${ctor}${objectOf([["name", stringLiteral(t.name)], ["time_intervals", periods]], 0, ctor.length)});`);
      mod.block(lines);
      mod.exports.push(v);
    }
  }

  // The routing tree: one Route, its children as plain RouteProps.
  if (config.route) {
    const mod = new Module("routes.ts", "The routing tree: the root route and its children, tried in order");
    modules.push(mod);
    mod.use("Route");
    const receiverRef = (name: string): unknown => {
      const r = receiverVars.get(name);
      if (!r) return name;
      mod.use(r.v, r.mod);
      return new Code(r.v);
    };
    const intervalRef = (name: string): unknown => {
      const t = intervalVars.get(name);
      if (!t) return name;
      mod.use(t.v, t.mod);
      return new Code(t.v);
    };
    const withRefs = (route: RouteConfig): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(route)) {
        if (x === undefined) continue;
        if (k === "receiver") out[k] = receiverRef(x as string);
        else if (k === "mute_time_intervals" || k === "active_time_intervals") out[k] = (x as string[]).map(intervalRef);
        else if (k === "routes") out[k] = (x as RouteConfig[]).map(withRefs);
        else out[k] = x;
      }
      return out;
    };
    const root = withRefs(config.route);
    const v = names.claim("root", "Route", "route");
    const lines: string[] = [];
    const entries: Array<[string, string]> = [];
    for (const [key, value] of Object.entries(root)) {
      if (!needsHoist(value)) {
        entries.push([key, tsLiteral(value, 2, 4 + key.length)]);
        continue;
      }
      const type = key === "routes" ? "RouteProps[]" : "LabelSet";
      mod.types.add(type.replace(/\[\]$/, ""));
      const c = names.claim(`${v} ${key === "routes" ? "children" : key}`, "", "route");
      const head = `const ${c}: ${type} = `;
      lines.push(`${head}${tsLiteral(value, 0, head.length)};`);
      entries.push([key, c]);
    }
    const ctor = `const ${v} = new Route(`;
    lines.push(`${ctor}${objectOf(entries, 0, ctor.length)});`);
    mod.block(lines);
    mod.exports.push(v);
  }

  // Inhibit rules.
  let inhibitCount = 0;
  for (const [mod, items] of chunk(config.inhibit_rules ?? [], "inhibit-rules", "Inhibit rules: alerts that mute others while they fire")) {
    modules.push(mod);
    mod.use("InhibitRule");
    items.forEach((rule: InhibitRuleConfig) => {
      inhibitCount++;
      const v = names.claim(rule.name ?? `inhibit rule ${inhibitCount}`, "Rule", "inhibit");
      const entries: Array<[string, string]> = Object.entries(rule)
        .filter(([, x]) => x !== undefined)
        .map(([k, x]) => [k, tsLiteral(x, 2, 4 + k.length)]);
      const ctor = `const ${v} = new InhibitRule(`;
      mod.block([`${ctor}${objectOf(entries, 0, ctor.length)});`]);
      mod.exports.push(v);
    });
  }

  // global, templates and tracing.
  if (config.global !== undefined || config.templates !== undefined || config.tracing !== undefined) {
    const mod = new Module("settings.ts", "global settings, notification templates and tracing");
    modules.push(mod);
    mod.use("AlertmanagerSettings");
    const lines: string[] = [];
    const entries: Array<[string, string]> = [];
    if (config.global !== undefined) {
      const typed: Array<[string, unknown]> = [];
      const untyped: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(config.global)) {
        if (GLOBAL_FIELDS.has(k)) typed.push([k, x]);
        else untyped[k] = x;
      }
      mod.types.add("AlertmanagerGlobalConfig");
      if (Object.keys(untyped).length > 0) {
        lines.push(...untypedComment("global:", Object.keys(untyped)));
        const head = "const globalUntyped = ";
        lines.push(`${head}${tsLiteral(untyped, 0, head.length)};`);
        const body: Array<[string, string]> = [["...globalUntyped", "globalUntyped"], ...typed.map(([k, x]): [string, string] => [k, tsLiteral(x, 2, 4 + k.length)])];
        lines.push(`const global: AlertmanagerGlobalConfig = ${objectOf(body, 0, 40)};`);
      } else {
        const head = "const global: AlertmanagerGlobalConfig = ";
        lines.push(`${head}${tsLiteral(Object.fromEntries(typed), 0, head.length)};`);
      }
      entries.push(["global", "global"]);
    }
    if (config.templates !== undefined) entries.push(["templates", tsLiteral(config.templates, 2, 15)]);
    if (config.tracing !== undefined) {
      mod.types.add("AlertmanagerTracingConfig");
      const head = "const tracing: AlertmanagerTracingConfig = ";
      lines.push(`${head}${tsLiteral(config.tracing, 0, head.length)};`);
      entries.push(["tracing", "tracing"]);
    }
    const v = names.claim("settings", "", "settings");
    const ctor = `const ${v} = new AlertmanagerSettings(`;
    lines.push(`${ctor}${objectOf(entries, 0, ctor.length)});`);
    mod.block(lines);
    mod.exports.push(v);
  }

  return modules.map((m) => ({ path: m.path, content: m.render() }));
}

/** The rule file and `alertmanager.yml` TypeScript generator `chant import` runs. */
export class PrometheusGenerator implements TypeScriptGenerator {
  generate(ir: TemplateIR): GeneratedFile[] {
    const files: GeneratedFile[] = [];
    for (const r of ir.resources) {
      if (r.type === RULE_FILE_RESOURCE_TYPE) {
        files.push(...generateRuleFileFiles((r.properties as unknown as RuleFileResourceProperties).file));
      } else if (r.type === ALERTMANAGER_RESOURCE_TYPE) {
        files.push(...generateAlertmanagerFiles((r.properties as unknown as AlertmanagerResourceProperties).config));
      }
    }
    // Core writes the first file of a generate() call as a whole module for some layouts; never hand it nothing.
    return files.length > 0 ? files : [{ path: "rules.ts", content: "// The imported file declares nothing.\n" }];
  }
}
