/**
 * `TemplateIR` -> TypeScript, for `chant import`.
 *
 * Writes the collector the way the lexicon's examples are written: a module
 * per section with one constant per component, typed by its built-in class
 * (`const otlpTempo = new OtlpExporter({ name: "tempo", ... })`), nested
 * settings lifted into consts typed by the component's config type (COR001),
 * at most eight declarables per module (COR009), and an `export { ... }` list
 * at the end of each. `pipelines.ts` declares a `Pipeline` per pipeline that
 * references those constants, and `service.ts` a `Service` when
 * `service.extensions` or `service.telemetry` needs one. A connector is one
 * constant, listed in the exporters of the pipeline that feeds it and the
 * receivers of the pipeline it feeds.
 *
 * A component type chant does not ship gets a `defineComponent` in
 * `custom-components.ts`, with its config carried as data and a comment
 * saying so. Its pin is the one the config's `# chant:` header named, or
 * `COLLECTOR_PIN`.
 */

import type { GeneratedFile, TypeScriptGenerator } from "@intentius/chant/import/generator";
import type { ResourceIR, TemplateIR } from "@intentius/chant/import/parser";
import * as components from "../components";
import { COLLECTOR_PIN, type ComponentClass, type SchemaPin } from "../define";
import {
  COMPONENT_KINDS,
  SECTION_OF,
  canonicalComponentType,
  SIGNALS,
  parseComponentId,
  pipelineSignal,
  type CollectorConfig,
  type ComponentKind,
} from "../model";
import {
  COLLECTOR_RESOURCE_TYPE,
  type CollectorResourceMetadata,
  type CollectorResourceProperties,
  type HeaderPin,
} from "./parser";

const PACKAGE = "@intentius/chant-lexicon-otel";

const KIND_SEGMENT: Record<ComponentKind, string> = {
  receiver: "Receiver",
  processor: "Processor",
  exporter: "Exporter",
  connector: "Connector",
  extension: "Extension",
};

/** `kind:type` -> the exported class name of every built-in. */
const BUILTIN_CLASSES: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const [exportName, value] of Object.entries(components)) {
    const def = (value as Partial<ComponentClass> | undefined)?.definition;
    if (typeof value === "function" && def?.builtin) map.set(`${def.kind}:${def.type}`, exportName);
  }
  return map;
})();

/**
 * The class name of the built-in for `kind` + `type`, if chant ships one.
 * A renamed built-in's new name (`span_metrics`) gives the class for the old
 * one, which emits the old name.
 */
export function builtinClassName(kind: ComponentKind, type: string): string | undefined {
  return BUILTIN_CLASSES.get(`${kind}:${type}`) ?? BUILTIN_CLASSES.get(`${kind}:${canonicalComponentType(kind, type)}`);
}

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
  const parts = words(text);
  if (parts.length === 0) return "";
  return parts
    .map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1)))
    .join("");
}

function pascal(text: string): string {
  return words(text)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

// ── TypeScript literals ──────────────────────────────────────────────

const MAX_LINE = 100;

function propertyKey(k: string): string {
  return IDENT.test(k) ? k : JSON.stringify(k);
}

/** A string literal: double-quoted, or single-quoted when that saves escaping `"` (OTTL reads better). */
function stringLiteral(s: string): string {
  const double = JSON.stringify(s);
  if (!s.includes('"') || s.includes("'")) return double;
  return `'${double.slice(1, -1).replace(/\\"/g, '"')}'`;
}

function scalarLiteral(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return stringLiteral(v);
  if (typeof v === "number") {
    if (Number.isNaN(v)) return "NaN";
    if (v === Infinity) return "Infinity";
    if (v === -Infinity) return "-Infinity";
    return String(v);
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  return JSON.stringify(String(v));
}

/** One-line rendering of a value. */
function inline(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(inline).join(", ")}]`;
  if (typeof v === "object" && v !== null) {
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
  if (col + one.length + 2 <= MAX_LINE) return one;
  const pad = " ".repeat(indent + 2);
  const close = " ".repeat(indent);
  if (Array.isArray(v)) {
    const items = v.map((x) => `${pad}${tsLiteral(x, indent + 2)},`);
    return `[\n${items.join("\n")}\n${close}]`;
  }
  if (typeof v === "object" && v !== null) {
    const lines: string[] = [];
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined) continue;
      const key = `${pad}${propertyKey(k)}: `;
      lines.push(`${key}${tsLiteral(x, indent + 2, key.length)},`);
    }
    return `{\n${lines.join("\n")}\n${close}}`;
  }
  return scalarLiteral(v);
}

/** An object literal whose entries are already-rendered expressions, starting at column `col`. */
function objectOf(entries: Array<[string, string]>, indent: number, col: number): string {
  if (entries.length === 0) return "{}";
  const prop = ([k, v]: [string, string]) => (k === v && IDENT.test(k) ? k : `${propertyKey(k)}: ${v}`);
  const one = `{ ${entries.map(prop).join(", ")} }`;
  if (!one.includes("\n") && col + one.length + 2 <= MAX_LINE) return one;
  const pad = " ".repeat(indent + 2);
  return `{\n${entries.map((e) => `${pad}${prop(e)},`).join("\n")}\n${" ".repeat(indent)}}`;
}

// ── naming ───────────────────────────────────────────────────────────

interface ComponentDecl {
  kind: ComponentKind;
  id: string;
  type: string;
  name?: string;
  config: Record<string, unknown>;
  className: string;
  builtin: boolean;
  varName: string;
}

interface PipelineDecl {
  id: string;
  signal: string;
  name?: string;
  lists: { receivers?: string[]; processors?: string[]; exporters?: string[] };
  varName: string;
}

function assignNames(comps: ComponentDecl[], pipes: PipelineDecl[], taken: Set<string>): void {
  const base = (s: string, fallback: string) => {
    const c = camel(s);
    return c === "" || /^[0-9]/.test(c) ? camel(`${fallback} ${s}`) : c;
  };
  const candidates = new Map<string, number>();
  const compBase = comps.map((c) => base(c.id, c.kind));
  const pipeBase = pipes.map((p) => base(p.id, "pipeline"));
  for (const b of [...compBase, ...pipeBase]) candidates.set(b, (candidates.get(b) ?? 0) + 1);
  const unique = (name: string) => {
    let out = name;
    for (let n = 2; taken.has(out) || RESERVED.has(out); n++) out = `${name}${n}`;
    taken.add(out);
    return out;
  };
  const clash = (b: string) => (candidates.get(b) ?? 0) > 1 || RESERVED.has(b) || taken.has(b);
  comps.forEach((c, i) => {
    const b = compBase[i];
    c.varName = unique(clash(b) ? `${b}${KIND_SEGMENT[c.kind]}` : b);
  });
  pipes.forEach((p, i) => {
    const b = pipeBase[i];
    p.varName = unique(clash(b) ? `${b}Pipeline` : b);
  });
}

// ── files ────────────────────────────────────────────────────────────

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
    const names = [...[...this.values].map((v) => v), ...[...this.types].map((t) => `type ${t}`)].sort((a, b) =>
      byName(a.replace(/^type /, ""), b.replace(/^type /, "")),
    );
    const lines = [`/** ${this.summary} */`];
    if (names.length > 0) {
      const one = `import { ${names.join(", ")} } from "${PACKAGE}";`;
      lines.push(one.length <= MAX_LINE ? one : `import {\n${names.map((n) => `  ${n},`).join("\n")}\n} from "${PACKAGE}";`);
    }
    for (const [spec, set] of [...this.local].sort(([a], [b]) => byName(a, b))) {
      lines.push(`import { ${[...set].sort(byName).join(", ")} } from "${spec}";`);
    }
    lines.push("", ...this.body);
    if (this.exports.length > 0) {
      const one = `export { ${this.exports.join(", ")} };`;
      lines.push("", one.length <= MAX_LINE ? one : `export {\n${this.exports.map((e) => `  ${e},`).join("\n")}\n};`);
    }
    return `${lines.join("\n")}\n`;
  }
}

/** Split `items` into files of at most `DECLARABLES_PER_FILE`, named `base.ts` or `base-1.ts`, `base-2.ts`, … */
function chunk<T>(items: T[], base: string, summary: string): Array<[Module, T[]]> {
  if (items.length === 0) return [];
  if (items.length <= DECLARABLES_PER_FILE) return [[new Module(`${base}.ts`, summary), items]];
  const out: Array<[Module, T[]]> = [];
  for (let i = 0; i < items.length; i += DECLARABLES_PER_FILE) {
    out.push([new Module(`${base}-${out.length + 1}.ts`, summary), items.slice(i, i + DECLARABLES_PER_FILE)]);
  }
  return out;
}

// ── generation ───────────────────────────────────────────────────────

function isCollectorResource(r: ResourceIR): boolean {
  return r.type === COLLECTOR_RESOURCE_TYPE;
}

function samePin(a: SchemaPin, b: SchemaPin): boolean {
  return a.source === b.source && a.version === b.version && (a.digest ?? "") === (b.digest ?? "");
}

/** True for a value COR001 wants in a named const rather than inline in a constructor. */
function needsHoist(v: unknown): boolean {
  if (Array.isArray(v)) return v.some((x) => typeof x === "object" && x !== null);
  return typeof v === "object" && v !== null;
}

const SECTION_SUMMARY: Record<ComponentKind, string> = {
  receiver: "Receivers",
  processor: "Processors",
  exporter: "Exporters",
  connector: "Connectors: each one is an exporter in the pipeline that feeds it and a receiver in the pipeline it feeds",
  extension: "Extensions",
};

/**
 * Generate the TypeScript declaring one collector config: one module per
 * section (split at eight declarables, as COR009 asks), `pipelines.ts`,
 * `service.ts` when the config needs a Service, and `custom-components.ts`
 * for component types chant does not ship.
 */
export function generateCollectorFiles(config: CollectorConfig, meta: Partial<CollectorResourceMetadata> = {}): GeneratedFile[] {
  const pins: HeaderPin[] = meta.pins ?? [];
  const comps: ComponentDecl[] = [];
  const customClasses = new Map<string, { className: string; kind: ComponentKind; type: string; pin: SchemaPin }>();
  const taken = new Set<string>(["Pipeline", "Service", "defineComponent", "COLLECTOR_PIN", "ServiceTelemetry", "telemetry"]);
  for (const cls of BUILTIN_CLASSES.values()) taken.add(cls).add(`${cls}Config`);

  for (const kind of COMPONENT_KINDS) {
    const section = config[SECTION_OF[kind]];
    for (const [id, raw] of Object.entries(section ?? {})) {
      const parsed = parseComponentId(id);
      const slash = id.indexOf("/");
      const type = parsed?.type ?? (slash === -1 ? id : id.slice(0, slash));
      const name = parsed ? parsed.name : slash === -1 ? undefined : id.slice(slash + 1);
      const { name: _dropped, ...cfg } = (raw ?? {}) as Record<string, unknown>;
      const builtin = builtinClassName(kind, type);
      let className = builtin;
      if (!className) {
        const key = `${kind}:${type}`;
        let custom = customClasses.get(key);
        if (!custom) {
          const base = `${/^[0-9]/.test(type) ? "Custom" : ""}${pascal(type) || "Custom"}${KIND_SEGMENT[kind]}`;
          let cn = base;
          for (let n = 2; taken.has(cn); n++) cn = `${base}${n}`;
          taken.add(cn);
          const headerPin = pins.find((p) => p.kind === kind && parseComponentId(p.id)?.type === type)?.pin;
          custom = { className: cn, kind, type, pin: headerPin ?? COLLECTOR_PIN };
          customClasses.set(key, custom);
        }
        className = custom.className;
      }
      comps.push({ kind, id, type, name, config: cfg, className, builtin: !!builtin, varName: "" });
    }
  }

  const pipes: PipelineDecl[] = Object.entries(config.service?.pipelines ?? {}).map(([id, lists]) => {
    const slash = id.indexOf("/");
    return {
      id,
      signal: pipelineSignal(id),
      name: slash === -1 ? undefined : id.slice(slash + 1),
      lists: lists ?? {},
      varName: "",
    };
  });

  assignNames(comps, pipes, taken);
  const unique = (name: string) => {
    let out = name;
    for (let n = 2; taken.has(out) || RESERVED.has(out); n++) out = `${name}${n}`;
    taken.add(out);
    return out;
  };

  const modules: Module[] = [];
  const home = new Map<string, Module>(); // variable or class name -> module declaring it

  // Custom component types, exported for every module that declares an instance.
  if (customClasses.size > 0) {
    const mod = new Module("custom-components.ts", "Component types chant does not ship, declared with defineComponent");
    modules.push(mod);
    mod.use("defineComponent");
    for (const custom of customClasses.values()) {
      const pinIsCollector = samePin(custom.pin, COLLECTOR_PIN);
      if (pinIsCollector) mod.use("COLLECTOR_PIN");
      mod.block([
        `// ${custom.kind} "${custom.type}" is not a component chant ships, so its config is carried as data`,
        "// and is not type-checked. Replace Record<string, unknown> with its config type to check it.",
        pinIsCollector
          ? "// The imported config named no schema pin for it, so it is pinned to COLLECTOR_PIN."
          : "// The pin is the one the imported config's `# chant:` header named.",
        `const ${custom.className} = defineComponent<Record<string, unknown>>()({`,
        `  kind: ${JSON.stringify(custom.kind)},`,
        `  type: ${JSON.stringify(custom.type)},`,
        `  pin: ${pinIsCollector ? "COLLECTOR_PIN" : tsLiteral({ ...custom.pin }, 2, 7)},`,
        "});",
      ]);
      mod.exports.push(custom.className);
      home.set(custom.className, mod);
    }
  }

  // Components, one module per section.
  for (const kind of COMPONENT_KINDS) {
    const ofKind = comps.filter((c) => c.kind === kind);
    for (const [mod, items] of chunk(ofKind, SECTION_OF[kind], SECTION_SUMMARY[kind])) {
      modules.push(mod);
      for (const c of items) {
        const lines: string[] = [];
        if (c.builtin) mod.use(c.className);
        else mod.use(c.className, home.get(c.className));
        const entries: Array<[string, string]> = [];
        if (c.name !== undefined) entries.push(["name", JSON.stringify(c.name)]);
        for (const [key, value] of Object.entries(c.config)) {
          if (value === undefined) continue;
          if (!needsHoist(value)) {
            entries.push([key, tsLiteral(value, 2, 4 + key.length)]);
            continue;
          }
          const constName = unique(`${c.varName}${pascal(key) || "Value"}`);
          let annotation = "";
          if (c.builtin) {
            mod.types.add(`${c.className}Config`);
            annotation = `: ${c.className}Config[${JSON.stringify(key)}]`;
          }
          const head = `const ${constName}${annotation} = `;
          lines.push(`${head}${tsLiteral(value, 0, head.length)};`);
          entries.push([key, constName]);
        }
        const head = `const ${c.varName} = new ${c.className}(`;
        lines.push(`${head}${entries.length === 0 ? "" : objectOf(entries, 0, head.length)});`);
        mod.block(lines);
        mod.exports.push(c.varName);
        home.set(c.varName, mod);
      }
    }
  }

  const byKindId = new Map<string, ComponentDecl>();
  for (const c of comps) byKindId.set(`${c.kind}:${c.id}`, c);
  const ref = (mod: Module, id: string, kinds: ComponentKind[]): string => {
    for (const k of kinds) {
      const c = byKindId.get(`${k}:${id}`);
      if (c) {
        mod.use(c.varName, home.get(c.varName));
        return c.varName;
      }
    }
    return JSON.stringify(id);
  };

  // Pipelines.
  for (const [mod, items] of chunk(pipes, "pipelines", "Pipelines")) {
    modules.push(mod);
    mod.use("Pipeline");
    for (const p of items) {
      const entries: Array<[string, string]> = [["signal", JSON.stringify(p.signal)]];
      if (p.name !== undefined) entries.push(["name", JSON.stringify(p.name)]);
      const list = (ids: string[] | undefined, kinds: ComponentKind[]) =>
        `[${(ids ?? []).map((id) => ref(mod, id, kinds)).join(", ")}]`;
      entries.push(["receivers", list(p.lists.receivers, ["receiver", "connector"])]);
      if (p.lists.processors && p.lists.processors.length > 0) {
        entries.push(["processors", list(p.lists.processors, ["processor"])]);
      }
      entries.push(["exporters", list(p.lists.exporters, ["exporter", "connector"])]);
      const head = `const ${p.varName} = new Pipeline(`;
      if ((SIGNALS as readonly string[]).includes(p.signal)) {
        mod.block([`${head}${objectOf(entries, 0, head.length)});`]);
      } else {
        mod.block([
          `${head}{`,
          `  // @ts-expect-error "${p.signal}" is a collector signal Pipeline does not type`,
          ...entries.map(([k, v]) => `  ${k}: ${v},`),
          "});",
        ]);
      }
      mod.exports.push(p.varName);
    }
  }

  // Service: only when the config says something the default does not.
  const declaredExtensions = comps.filter((c) => c.kind === "extension").map((c) => c.id);
  const enabled = config.service?.extensions;
  const telemetry = config.service?.telemetry;
  const extensionsDiffer =
    enabled === undefined
      ? declaredExtensions.length > 0
      : enabled.length !== declaredExtensions.length || enabled.some((id, i) => declaredExtensions[i] !== id);
  if (extensionsDiffer || telemetry !== undefined) {
    const mod = new Module("service.ts", "service.extensions and service.telemetry");
    modules.push(mod);
    mod.use("Service");
    const lines: string[] = [];
    const entries: Array<[string, string]> = [];
    if (extensionsDiffer) entries.push(["extensions", `[${(enabled ?? []).map((id) => ref(mod, id, ["extension"])).join(", ")}]`]);
    if (telemetry !== undefined) {
      mod.types.add("ServiceTelemetry");
      const head = "const telemetry: ServiceTelemetry = ";
      lines.push(`${head}${tsLiteral(telemetry, 0, head.length)};`);
      entries.push(["telemetry", "telemetry"]);
    }
    const serviceName = unique("service");
    const head = `const ${serviceName} = new Service(`;
    lines.push(`${head}${objectOf(entries, 0, head.length)});`);
    mod.block(lines);
    mod.exports.push(serviceName);
  }

  return modules.map((m) => ({ path: m.path, content: m.render() }));
}

/** The OpenTelemetry Collector TypeScript generator `chant import` runs. */
export class OtelCollectorGenerator implements TypeScriptGenerator {
  generate(ir: TemplateIR): GeneratedFile[] {
    const resource = ir.resources.find(isCollectorResource);
    const props = resource?.properties as unknown as CollectorResourceProperties | undefined;
    const meta = resource?.metadata as unknown as CollectorResourceMetadata | undefined;
    const files = generateCollectorFiles(props?.config ?? {}, meta ?? {});
    // Core writes the first file of a generate() call as a whole module for some layouts; never hand it nothing.
    return files.length > 0 ? files : [{ path: "pipelines.ts", content: "// The imported config declares nothing.\n" }];
  }
}
