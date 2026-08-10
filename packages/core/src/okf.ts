import { relative, isAbsolute } from "node:path";
import type { Declarable } from "./declarable";
import { buildGraphIr } from "./graph-ir";
import { isLexiconOutput, type LexiconOutput } from "./lexicon-output";
import { getProvenance } from "./provenance";
import { emitYAML, parseYAML } from "./yaml";

/**
 * OKF bundle emitter (#1058, epic #1057) — projects a discovered entity graph
 * into an Open Knowledge Format v0.2 bundle: a directory of markdown files
 * with YAML frontmatter, per the spec at
 * https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
 *
 * One concept document per entity, `type` carrying the entity's resource type
 * string, dependency edges as bundle-relative markdown links (the form the
 * spec recommends for stability), and a root `index.md` grouping concepts into
 * per-lexicon sections. Emit-only: OKF as project *input* is #1059.
 */

export const OKF_VERSION = "0.2";

/** One file of an OKF bundle: a bundle-relative path and its full content. */
export interface OkfFile {
  /** Bundle-relative path, e.g. "aws/myBucket.md" or "index.md". */
  path: string;
  content: string;
}

/** The subset of a discovery result the emitter reads. */
export interface OkfBundleInput {
  entities: Map<string, Declarable>;
  dependencies: Map<string, Set<string>>;
}

/** Make an entity or lexicon name safe as a single path segment. */
export function slug(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "");
  return cleaned === "" ? "unnamed" : cleaned;
}

function relFile(file: string | undefined, projectPath?: string): string | undefined {
  if (!file) return undefined;
  if (projectPath && isAbsolute(file)) {
    const rel = relative(projectPath, file);
    return rel.startsWith("..") ? file : rel;
  }
  return file;
}

/**
 * Render a flat frontmatter mapping as a YAML block. Keys with undefined
 * values are dropped; scalar quoting is `emitYAML`'s.
 */
export function frontmatter(fields: Record<string, string | undefined>): string {
  const lines: string[] = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    lines.push(`${key}: ${emitYAML(value, 0)}`);
  }
  lines.push("---");
  return lines.join("\n");
}

/**
 * Split a concept document into its frontmatter block and body. Returns
 * undefined when the document does not start with a `---` delimited block.
 * Exported for the conformance tests (and any future OKF consumer, #1059).
 */
export function splitFrontmatter(content: string): { frontmatter: string; body: string } | undefined {
  const lines = content.split("\n");
  if (lines[0] !== "---") return undefined;
  const end = lines.indexOf("---", 1);
  if (end === -1) return undefined;
  return {
    frontmatter: lines.slice(1, end).join("\n"),
    body: lines.slice(end + 1).join("\n"),
  };
}

/**
 * Check a bundle against the OKF v0.2 conformance criteria (spec §11) and
 * return every violation found: parseable frontmatter on every non-reserved
 * `.md`, a non-empty `type` everywhere, a well-formed root `index.md`, and
 * generated cross-link entries that are bundle-absolute (or external URLs).
 * Empty result means conformant. Shared by the project-bundle tests (#1058)
 * and every lexicon's bundle tests (#1060).
 */
export function okfConformanceProblems(files: OkfFile[]): string[] {
  const problems: string[] = [];
  const reserved = new Set(["index.md", "log.md"]);
  const linkTarget = /\]\(([^)]+)\)/g;
  const externalOrAbsolute = (target: string): boolean =>
    target.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(target);

  for (const file of files) {
    if (!file.path.endsWith(".md")) problems.push(`${file.path}: not a markdown file`);
    if (file.path.startsWith("/") || file.path.includes("..")) {
      problems.push(`${file.path}: path is not bundle-relative`);
    }
    if (reserved.has(file.path.split("/").pop()!)) continue;

    const split = splitFrontmatter(file.content);
    if (!split) {
      problems.push(`${file.path}: no frontmatter block`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = parseYAML(split.frontmatter);
    } catch {
      problems.push(`${file.path}: unparseable frontmatter`);
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) {
      problems.push(`${file.path}: frontmatter is not a mapping`);
      continue;
    }
    const type = (parsed as Record<string, unknown>).type;
    if (typeof type !== "string" || type.length === 0) {
      problems.push(`${file.path}: frontmatter has no non-empty type`);
    }
    // Cross-link entries (the "- [name](target)" lines the emitters generate)
    // must point inside the bundle or at an external URL. Broken targets are
    // permitted (not-yet-written knowledge); malformed ones are not. Free-text
    // knowledge bodies may carry arbitrary links and are not checked.
    for (const line of split.body.split("\n")) {
      if (!line.trimStart().startsWith("- [")) continue;
      for (const match of line.matchAll(linkTarget)) {
        if (!externalOrAbsolute(match[1])) {
          problems.push(`${file.path}: link target "${match[1]}" is neither bundle-absolute nor external`);
        }
      }
    }
  }

  const index = files.find((f) => f.path === "index.md");
  if (!index) {
    problems.push("bundle has no root index.md");
    return problems;
  }
  const split = splitFrontmatter(index.content);
  if (!split) {
    problems.push("index.md: no frontmatter block");
    return problems;
  }
  const parsed = parseYAML(split.frontmatter);
  for (const key of Object.keys(parsed ?? {})) {
    if (key !== "okf_version") problems.push(`index.md: frontmatter carries "${key}" — okf_version is the only key an index is allowed`);
  }
  for (const line of split.body.split("\n")) {
    if (line.startsWith("*") && !/^\* \[[^\]]+\]\([^)]+\) - .+$/.test(line)) {
      problems.push(`index.md: malformed entry line: ${line}`);
    }
  }
  return problems;
}

interface Concept {
  name: string;
  entity: Declarable;
  /** Bundle-relative concept path, e.g. "aws/myBucket.md". */
  path: string;
  lexicon: string;
  /** The frontmatter `type` — the entity's resource type string. */
  type: string;
  kind: string;
}

/**
 * The `type`/`lexicon`/`kind` a concept carries. Most entities state all
 * three; a `LexiconOutput` (an `output(...)` bridge) carries none of them
 * directly, so its facts come from its producing side — `type` must be
 * non-empty for the bundle to conform, never blank.
 */
function conceptFacts(entity: Declarable): { type: string; lexicon: string; kind: string } {
  if (isLexiconOutput(entity)) {
    const out = entity as unknown as LexiconOutput;
    return { type: "Output", lexicon: out.sourceLexicon || "unknown", kind: "output" };
  }
  return {
    type: entity.entityType || "Entity",
    lexicon: entity.lexicon || "unknown",
    kind: entity.kind ?? "resource",
  };
}

/**
 * Build the OKF bundle for a discovered graph. Pure and deterministic: the
 * same entities yield byte-identical files, so bundles are diffable and
 * snapshot-testable. `projectPath` relativizes source-file paths so the
 * bundle is portable.
 */
export function buildOkfBundle(input: OkfBundleInput, projectPath?: string): OkfFile[] {
  // Assign each entity a stable concept path: <lexicon>/<name>.md, deduped
  // when slugging collides two distinct names.
  const concepts = new Map<string, Concept>();
  const takenPaths = new Set<string>();
  const names = [...input.entities.keys()].sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    const entity = input.entities.get(name)!;
    const facts = conceptFacts(entity);
    const base = `${slug(facts.lexicon)}/${slug(name)}`;
    let path = `${base}.md`;
    for (let n = 2; takenPaths.has(path); n++) path = `${base}-${n}.md`;
    takenPaths.add(path);
    concepts.set(name, { name, entity, path, ...facts });
  }

  // Dependency edges: the graph IR's AttrRef/Ref-derived edges (the same
  // derivation `chant graph --format ir` ships) unioned with discovery's
  // declared dependency map — the map alone misses references that live only
  // in attribute values.
  const dependsOn = new Map<string, Set<string>>();
  const addEdge = (from: string, to: string): void => {
    if (!dependsOn.has(from)) dependsOn.set(from, new Set());
    dependsOn.get(from)!.add(to);
  };
  for (const edge of buildGraphIr(input.entities, projectPath).edges) addEdge(edge.from, edge.to);
  for (const [from, deps] of input.dependencies) for (const to of deps) addEdge(from, to);

  // Reverse edges: who references each entity.
  const referencedBy = new Map<string, string[]>();
  for (const [from, deps] of dependsOn) {
    for (const to of deps) {
      if (!referencedBy.has(to)) referencedBy.set(to, []);
      referencedBy.get(to)!.push(from);
    }
  }

  const files: OkfFile[] = [];

  for (const name of names) {
    const concept = concepts.get(name)!;
    const { entity } = concept;
    const prov = getProvenance(entity);
    const source = relFile(prov?.sourceFile, projectPath);

    const head = frontmatter({
      type: concept.type,
      title: name,
      description: `${concept.lexicon} ${concept.kind} of type ${concept.type}`,
      name,
      lexicon: concept.lexicon,
      kind: concept.kind,
      source,
      composite: prov?.composite,
      composite_instance: prov?.compositeInstance,
    });

    const body: string[] = [""];
    body.push(source ? `Declared in \`${source}\`.` : `Declared by the ${concept.lexicon} lexicon.`);

    // Cross-resource references become bundle-relative links. A dependency
    // whose target is not in the bundle still emits a link — the spec permits
    // broken links (not-yet-written knowledge), so unresolved never fails.
    const deps = [...(dependsOn.get(name) ?? [])].sort((a, b) => a.localeCompare(b));
    if (deps.length > 0) {
      body.push("", "## Depends on", "");
      for (const dep of deps) {
        const target = concepts.get(dep)?.path ?? `${slug(dep)}.md`;
        body.push(`- [${dep}](/${target})`);
      }
    }

    const consumers = (referencedBy.get(name) ?? []).sort((a, b) => a.localeCompare(b));
    if (consumers.length > 0) {
      body.push("", "## Referenced by", "");
      for (const consumer of consumers) {
        const target = concepts.get(consumer)?.path ?? `${slug(consumer)}.md`;
        body.push(`- [${consumer}](/${target})`);
      }
    }

    body.push("");
    files.push({ path: concept.path, content: head + body.join("\n") });
  }

  files.push({ path: "index.md", content: buildIndex(concepts, names) });
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

/**
 * The bundle-root `index.md` (spec §8): one section per lexicon, each entry a
 * bundle-relative link plus the concept's description — the spec's
 * progressive-disclosure mechanism. Root indexes may carry `okf_version`
 * frontmatter (spec §12), the only frontmatter an index is allowed.
 */
function buildIndex(concepts: Map<string, Concept>, names: string[]): string {
  const byLexicon = new Map<string, Concept[]>();
  for (const name of names) {
    const concept = concepts.get(name)!;
    if (!byLexicon.has(concept.lexicon)) byLexicon.set(concept.lexicon, []);
    byLexicon.get(concept.lexicon)!.push(concept);
  }

  const lines: string[] = ["---", `okf_version: '${OKF_VERSION}'`, "---", ""];
  const lexicons = [...byLexicon.keys()].sort((a, b) => a.localeCompare(b));
  for (const lexicon of lexicons) {
    lines.push(`# Lexicon: ${lexicon}`, "");
    for (const concept of byLexicon.get(lexicon)!) {
      lines.push(`* [${concept.name}](/${concept.path}) - ${lexicon} ${concept.kind} of type ${concept.type}`);
    }
    lines.push("");
  }
  if (lexicons.length === 0) lines.push("No entities discovered.", "");
  return lines.join("\n");
}
