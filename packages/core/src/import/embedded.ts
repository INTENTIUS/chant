/**
 * Content embedded in another lexicon's resources, imported by the lexicon
 * that owns it (#2962).
 *
 * A Kubernetes ConfigMap holding a collector's `config.yaml`, a
 * `PrometheusRule` whose `spec.groups` are Prometheus rule groups, and a
 * ConfigMap holding Grafana dashboard JSON all carry another lexicon's
 * source inside a k8s resource. The host lexicon's parser (k8s) finds such
 * content and offers it here; the lexicon that can import it (otel,
 * prometheus, grafana) declares so with `LexiconPlugin.embeddedImporters()`.
 * Core matches the two at run time, so the host needs no dependency on the
 * owner: when the owner is not installed the content stays as written, with
 * a warning.
 *
 * The flow, driven by `chant import`:
 *
 * 1. The host's `TemplateParser.parse(content, context)` calls
 *    `context.embedded.resolve(site)` for each place content can be
 *    embedded, and puts the `EmbeddedReference` it gets back into its IR in
 *    place of the raw value. `undefined` means keep the raw value.
 * 2. The owner's `EmbeddedContentImporter.import(site)` returns the modules
 *    declaring the content and how the host's value is built from them
 *    (`collectorYaml([...])`, a list of rule groups, `dashboardJson(...)`).
 * 3. Core writes those modules in a directory of their own beside the
 *    host's files, and the host's generator renders the reference with
 *    `renderEmbeddedReference`, which also writes the imports it needs.
 */

import { posix } from "path";
import { parseYAMLDocument, splitYAMLDocuments } from "../yaml";
import type { GeneratedFile } from "./generator";

// ── what the host offers ─────────────────────────────────────────────

/** One place in a host resource that may hold another lexicon's content. */
export interface EmbeddedContent {
  /** The host lexicon, e.g. `"k8s"`. */
  readonly host: string;
  /** The host resource's type, e.g. `"K8s::Core::ConfigMap"`. */
  readonly hostType: string;
  /** Where it is, for messages: `ConfigMap otel-agent data["config.yaml"]`. */
  readonly location: string;
  /** A name for the directory its modules are written to; core makes it unique. */
  readonly directory: string;
  /** The content as text, when the host holds it as text (a ConfigMap value). */
  readonly text?: string;
  /**
   * The content as the document it would be in a file of its own. Core
   * parses `text` into it (JSON, then YAML) when the host leaves it out.
   * `PrometheusRule` `spec.groups` is offered as `{ groups: [...] }`, the rule
   * file those groups would make.
   */
  readonly document?: unknown;
  /**
   * When the host's value is one member of `document` rather than the whole
   * of it: `"groups"` for `spec.groups`. The reference must then evaluate to
   * `document[select]`. Absent, it evaluates to `text`.
   */
  readonly select?: string;
  /** The host resource's labels, where the host has them. */
  readonly labels?: Readonly<Record<string, string>>;
  /**
   * The lexicon the host expects to own this content, from conventions it
   * knows (a PrometheusRule's groups are Prometheus rules). Only used for the
   * warning when no installed lexicon imports the content.
   */
  readonly expectedOwner?: { readonly lexicon: string; readonly what: string };
}

/** A declaration the host's value is built from. */
export interface EmbeddedBinding {
  /** A package (`@intentius/chant-lexicon-otel`) or the path of one of the import's `files`. */
  readonly from: string;
  /** The exported name. */
  readonly name: string;
  /** A member of it the value uses instead, e.g. an `Slo`'s `rules`. */
  readonly member?: string;
}

/** How the host's value is built from the imported declarations. */
export interface EmbeddedValue {
  /** The declarations, in order. */
  readonly bindings: readonly EmbeddedBinding[];
  /** `"list"`: an array of them. `"single"`: the one binding. */
  readonly shape: "list" | "single";
  /** A function the value is passed through, e.g. otel's `collectorYaml`. */
  readonly through?: { readonly from: string; readonly name: string };
}

/** What an owner's importer returns for one piece of content. */
export interface EmbeddedImport {
  /** The modules declaring the content, at paths relative to their own directory. */
  readonly files: readonly GeneratedFile[];
  readonly value: EmbeddedValue;
  /** What the import read but could not carry. */
  readonly warnings?: readonly string[];
}

/** An owner lexicon's declaration that it can import content embedded in another's resources. */
export interface EmbeddedContentImporter {
  /** What it imports, for messages: `"an OpenTelemetry Collector config"`. */
  readonly what: string;
  /** Whether this content is one it imports. Must not throw on content that is not. */
  matches(content: EmbeddedContent): boolean;
  /**
   * Why content it matches is kept as written instead of imported, or
   * `undefined` to import it. Asked before `import`; the reason is the
   * warning's. grafana keeps a v2 dashboard, which it reads but would build
   * back as v1 JSON (#3031).
   */
  keepsAsWritten?(content: EmbeddedContent): string | undefined;
  /** Import it. A throw keeps the content as written, with a warning. */
  import(content: EmbeddedContent): EmbeddedImport;
}

/** An importer with the lexicon that registered it. */
export interface RegisteredEmbeddedImporter {
  readonly lexicon: string;
  readonly importer: EmbeddedContentImporter;
}

// ── what the host gets back ──────────────────────────────────────────

/**
 * What the host puts in its IR in place of the raw value. Plain data: the
 * bindings' local paths are relative to the import's output directory.
 */
export interface EmbeddedReference {
  readonly $embedded: {
    readonly lexicon: string;
    readonly what: string;
    readonly location: string;
    readonly value: EmbeddedValue;
  };
}

export function isEmbeddedReference(value: unknown): value is EmbeddedReference {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const e = (value as { $embedded?: unknown }).$embedded;
  return (
    typeof e === "object" &&
    e !== null &&
    Array.isArray((e as { value?: { bindings?: unknown } }).value?.bindings)
  );
}

/** What a host's parser is handed to resolve embedded content. */
export interface EmbeddedContentResolver {
  /** The reference to put in place of the content, or undefined to keep it as written. */
  resolve(content: EmbeddedContent): EmbeddedReference | undefined;
}

// ── the registry ─────────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The document a text holds: JSON, or a single YAML document. Undefined for anything else. */
export function embeddedDocument(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON: try YAML.
  }
  const docs = splitYAMLDocuments(text);
  if (docs.length !== 1) return undefined;
  let doc: unknown;
  try {
    doc = parseYAMLDocument(docs[0]);
  } catch {
    return undefined;
  }
  // Text that is not YAML (`just text`, `KEY=value` lines) makes core's YAML
  // reader throw, caught above (#2991); an empty or comment-only text reads
  // as an empty mapping. Neither is a document.
  if (typeof doc === "object" && doc !== null && Object.keys(doc).length === 0) return undefined;
  return doc;
}

/** A directory name: lower-case letters, digits and `-`. */
function slug(text: string): string {
  const s = text
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s === "" ? "embedded" : s;
}

/**
 * Resolves embedded content against the importers registered for one
 * import, and collects what the imports produce: the files to write beside
 * the host's and the warnings to print. `offered` lists every piece of
 * content the host offered, claimed or not.
 */
export class EmbeddedImports implements EmbeddedContentResolver {
  readonly offered: EmbeddedContent[] = [];
  readonly files: GeneratedFile[] = [];
  readonly warnings: string[] = [];
  private readonly directories = new Set<string>();

  /**
   * @param importers what the installed lexicons registered, in the order they are asked
   * @param options.quiet collect `offered` only, with no warnings (a probe before the importers are known)
   */
  constructor(
    private readonly importers: readonly RegisteredEmbeddedImporter[] = [],
    private readonly options: { quiet?: boolean } = {},
  ) {}

  resolve(offered: EmbeddedContent): EmbeddedReference | undefined {
    const content: EmbeddedContent =
      offered.document === undefined && typeof offered.text === "string"
        ? { ...offered, document: embeddedDocument(offered.text) }
        : offered;
    this.offered.push(content);

    const matching = this.importers.filter(({ importer }) => {
      try {
        return importer.matches(content);
      } catch {
        return false;
      }
    });
    const [chosen, ...others] = matching;
    if (!chosen) {
      const owner = content.expectedOwner;
      if (owner && !this.options.quiet) {
        this.warnings.push(
          `${content.location} looks like ${owner.what}, and no installed lexicon imports it, so it is kept as written. ` +
            `Install @intentius/chant-lexicon-${owner.lexicon} (or a version that imports embedded content) to import it as typed declarations.`,
        );
      }
      return undefined;
    }
    if (others.length > 0) {
      this.warnings.push(
        `${content.location} is also importable by ${others.map((o) => o.lexicon).join(", ")}; imported with ${chosen.lexicon}.`,
      );
    }

    const kept = chosen.importer.keepsAsWritten?.(content);
    if (kept !== undefined) {
      this.warnings.push(`${content.location} is ${chosen.importer.what}, kept as written: ${kept}`);
      return undefined;
    }

    let result: EmbeddedImport;
    try {
      result = chosen.importer.import(content);
    } catch (err) {
      this.warnings.push(
        `${content.location} looks like ${chosen.importer.what}, but the ${chosen.lexicon} import failed, so it is kept as written: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return undefined;
    }

    const dir = this.claimDirectory(content.directory);
    const local = new Set(result.files.map((f) => f.path));
    const rebase = (from: string) => (local.has(from) ? `${dir}/${from}` : from);
    for (const f of result.files) this.files.push({ path: `${dir}/${f.path}`, content: f.content });
    for (const w of result.warnings ?? []) this.warnings.push(`${content.location}: ${w}`);

    const v = result.value;
    const value: EmbeddedValue = {
      bindings: v.bindings.map((b) => ({ ...b, from: rebase(b.from) })),
      shape: v.shape,
      ...(v.through ? { through: { ...v.through, from: rebase(v.through.from) } } : {}),
    };
    return {
      $embedded: { lexicon: chosen.lexicon, what: chosen.importer.what, location: content.location, value },
    };
  }

  private claimDirectory(name: string): string {
    const base = slug(name);
    let dir = base;
    for (let n = 2; this.directories.has(dir); n++) dir = `${base}-${n}`;
    this.directories.add(dir);
    return dir;
  }
}

// ── rendering ────────────────────────────────────────────────────────

const RESERVED = new Set(
  (
    "break case catch class const continue debugger default delete do else enum export extends false finally for " +
    "function if import in instanceof new null return super switch this throw true try typeof var void while with " +
    "yield let static implements interface package private protected public await arguments eval undefined"
  ).split(" "),
);

/**
 * The imports one generated module needs for the references it renders.
 * Names are made unique against the module's own declarations: a second
 * `otlp` from another collector's directory is imported as `otlp2`.
 */
export class EmbeddedImportScope {
  private readonly taken: Set<string>;
  /** specifier -> exported name -> local name */
  private readonly bySpecifier = new Map<string, Map<string, string>>();

  /**
   * @param fromDir the directory of the module being generated, relative to the output directory (`""` for its top)
   * @param taken names the module already declares or imports
   */
  constructor(
    private readonly fromDir: string,
    taken: Iterable<string> = [],
  ) {
    this.taken = new Set(taken);
  }

  /** The local name `name`, exported by `from` (a package or an output-relative path), is used under. */
  bind(from: string, name: string): string {
    const spec = this.specifier(from);
    let names = this.bySpecifier.get(spec);
    if (!names) {
      names = new Map();
      this.bySpecifier.set(spec, names);
    }
    const existing = names.get(name);
    if (existing) return existing;
    let local = name;
    for (let n = 2; this.taken.has(local) || RESERVED.has(local); n++) local = `${name}${n}`;
    this.taken.add(local);
    names.set(name, local);
    return local;
  }

  /** The import statements, packages first, then local modules, each sorted. */
  lines(): string[] {
    const specs = [...this.bySpecifier.keys()].sort((a, b) => {
      const la = a.startsWith("."), lb = b.startsWith(".");
      return la === lb ? a.localeCompare(b) : la ? 1 : -1;
    });
    return specs.map((spec) => {
      const entries = [...this.bySpecifier.get(spec)!].sort(([a], [b]) => a.localeCompare(b));
      const list = entries.map(([name, local]) => (name === local ? name : `${name} as ${local}`));
      const one = `import { ${list.join(", ")} } from "${spec}";`;
      return one.length <= 100 ? one : `import {\n${list.map((n) => `  ${n},`).join("\n")}\n} from "${spec}";`;
    });
  }

  private specifier(from: string): string {
    if (!from.endsWith(".ts")) return from;
    let rel = posix.relative(this.fromDir || ".", from.replace(/\.ts$/, ""));
    if (!rel.startsWith(".")) rel = `./${rel}`;
    return rel;
  }
}

/**
 * The TypeScript expression for a reference, binding its names in `scope`.
 * A list longer than one line is broken one binding per line, indented from
 * `indent` spaces.
 */
export function renderEmbeddedReference(ref: EmbeddedReference, scope: EmbeddedImportScope, indent = 0): string {
  const { value } = ref.$embedded;
  const items = value.bindings.map((b) => `${scope.bind(b.from, b.name)}${b.member ? `.${b.member}` : ""}`);
  let inner: string;
  if (value.shape === "single") {
    if (items.length !== 1) throw new Error(`${ref.$embedded.location}: a single embedded value needs exactly one binding`);
    inner = items[0];
  } else {
    const one = `[${items.join(", ")}]`;
    const pad = " ".repeat(indent);
    inner = one.length <= 80 ? one : `[\n${items.map((i) => `${pad}  ${i},`).join("\n")}\n${pad}]`;
  }
  return value.through ? `${scope.bind(value.through.from, value.through.name)}(${inner})` : inner;
}

/**
 * The names a generated module exports in its `export { … }` list, for an
 * importer whose generator writes one per module (COR004).
 */
export function exportedNames(content: string): string[] {
  const names: string[] = [];
  for (const m of content.matchAll(/^export\s*\{([^}]*)\};?\s*$/gm)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()!.trim();
      if (name !== "" && !name.startsWith("type ")) names.push(name);
    }
  }
  return names;
}
