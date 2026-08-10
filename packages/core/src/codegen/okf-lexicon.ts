/**
 * Lexicon OKF knowledge bundle (#1060, epic #1057) — projects a packaged
 * lexicon's resource-type registry and lint rules into an Open Knowledge
 * Format v0.2 bundle, emitted alongside the other build artifacts
 * (`dist/meta.json`, `dist/types/`) as `dist/okf/`.
 *
 * Vocabulary, resolved against the project bundle (#1058, ../okf.ts): there a
 * concept's `type` IS the entity's resource type; here `type` is the concept
 * *category* — `resource-type`, `lint-rule`, `post-synth-check` — and the
 * resource type string rides in `resource_type`. A consumer tells the two
 * bundle kinds apart by exactly that.
 *
 * Cross-links run both directions: a resource concept lists the rules that
 * govern it under "Governed by", a rule concept lists the types it applies to
 * under "Applies to". The association is derived from the rule's source text
 * (rules match on identifiers, not declared type lists), so it is a textual
 * over-approximation — acceptable for knowledge, wrong for enforcement.
 */

import * as ts from "typescript";
import { frontmatter, slug, OKF_VERSION, type OkfFile } from "../okf";
import type { ScannedRule } from "./docs-rule-scanning";

export interface LexiconOkfInput {
  /** Lexicon name as the manifest states it, e.g. "aws". */
  name: string;
  /** The registry JSON — the exact content of `dist/meta.json`. */
  registry: string;
  /** The generated declarations — the content of `dist/types/index.d.ts`. */
  typesDTS: string;
  /** Scanned rules with their sources, for metadata and type association. */
  rules: ScannedRule[];
}

interface RegistryEntry {
  resourceType?: unknown;
  kind?: unknown;
  description?: unknown;
  properties?: Record<string, { type?: string; description?: string }>;
  attrs?: Record<string, string>;
}

interface ConceptProperty {
  name: string;
  type?: string;
  required?: boolean;
  description?: string;
}

interface TypeConcept {
  className: string;
  resourceType: string;
  description?: string;
  properties: ConceptProperty[];
  attributes: string[];
  path: string;
}

/** Collapse whitespace so a description fits a frontmatter scalar or a list line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3).trimEnd()}...`;
}

/**
 * Per-class constructor property docs, parsed out of the generated
 * declarations. This is where CloudFormation- and OpenAPI-derived lexicons
 * carry their spec-sourced property descriptions (the registry carries them
 * only for hand-authored lexicons like docker).
 */
function parseDtsProperties(typesDTS: string): Map<string, ConceptProperty[]> {
  const out = new Map<string, ConceptProperty[]>();
  if (!typesDTS.includes("constructor")) return out;
  const sf = ts.createSourceFile("types.d.ts", typesDTS, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  for (const stmt of sf.statements) {
    if (!ts.isClassDeclaration(stmt) || !stmt.name) continue;
    const ctor = stmt.members.find(ts.isConstructorDeclaration);
    const param = ctor?.parameters[0];
    if (!param?.type || !ts.isTypeLiteralNode(param.type)) continue;
    const props: ConceptProperty[] = [];
    for (const member of param.type.members) {
      if (!ts.isPropertySignature(member) || !member.name) continue;
      const name =
        ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)
          ? member.name.text
          : member.name.getText(sf);
      const raw = (member as unknown as { jsDoc?: ts.JSDoc[] }).jsDoc?.[0]?.comment;
      const doc = typeof raw === "string" ? raw : raw ? ts.getTextOfJSDocComment(raw) : undefined;
      props.push({
        name,
        type: member.type?.getText(sf),
        required: member.questionToken === undefined,
        // Undo the `*\/` escaping generate-typescript applies inside JSDoc.
        description: doc?.replace(/\*\\\//g, "*/"),
      });
    }
    if (props.length > 0) out.set(stmt.name.text, props);
  }
  return out;
}

/**
 * The resource types a rule's source mentions — by class name as a whole
 * word, or by the resource type string anywhere.
 */
function ruleAppliesTo(source: string, concepts: TypeConcept[]): TypeConcept[] {
  const words = new Set(source.match(/[A-Za-z0-9_$]+/g) ?? []);
  return concepts.filter((c) => words.has(c.className) || source.includes(c.resourceType));
}

function propertyLine(prop: ConceptProperty): string {
  const facts: string[] = [];
  if (prop.type) facts.push(`\`${oneLine(prop.type)}\``);
  if (prop.required === true) facts.push("required");
  if (prop.required === false) facts.push("optional");
  const head = facts.length > 0 ? `- \`${prop.name}\` (${facts.join(", ")})` : `- \`${prop.name}\``;
  return prop.description ? `${head}: ${oneLine(prop.description)}` : head;
}

/**
 * Build the OKF bundle for a packaged lexicon. Pure and deterministic: the
 * same registry, declarations, and rules yield byte-identical files.
 */
export function buildLexiconOkfBundle(input: LexiconOkfInput): OkfFile[] {
  let registry: Record<string, RegistryEntry>;
  try {
    registry = JSON.parse(input.registry) as Record<string, RegistryEntry>;
  } catch {
    registry = {};
  }
  const dtsProps = parseDtsProperties(input.typesDTS);

  // One concept per resource type: alias entries share a resourceType, the
  // first class name in sorted order names the concept.
  const byType = new Map<string, { className: string; entry: RegistryEntry }>();
  for (const className of Object.keys(registry).sort((a, b) => a.localeCompare(b))) {
    const entry = registry[className];
    if (entry?.kind !== "resource" || typeof entry.resourceType !== "string") continue;
    if (!byType.has(entry.resourceType)) byType.set(entry.resourceType, { className, entry });
  }

  const concepts: TypeConcept[] = [];
  const takenPaths = new Set<string>();
  for (const { className, entry } of [...byType.values()].sort((a, b) => a.className.localeCompare(b.className))) {
    const base = `types/${slug(className)}`;
    let path = `${base}.md`;
    for (let n = 2; takenPaths.has(path); n++) path = `${base}-${n}.md`;
    takenPaths.add(path);

    // Registry-carried property docs (hand-authored lexicons) win; the
    // generated declarations fill in for spec-derived lexicons.
    let properties: ConceptProperty[];
    if (entry.properties && Object.keys(entry.properties).length > 0) {
      properties = Object.entries(entry.properties).map(([name, p]) => ({
        name,
        type: p.type,
        description: p.description,
      }));
    } else {
      properties = dtsProps.get(className) ?? [];
    }

    concepts.push({
      className,
      resourceType: entry.resourceType as string,
      description: typeof entry.description === "string" ? entry.description : undefined,
      properties,
      attributes: entry.attrs ? Object.values(entry.attrs).sort((a, b) => a.localeCompare(b)) : [],
      path,
    });
  }

  // One concept per rule id, first scan wins.
  const rulesById = new Map<string, ScannedRule>();
  for (const rule of input.rules) {
    if (!rulesById.has(rule.meta.id)) rulesById.set(rule.meta.id, rule);
  }
  const rules = [...rulesById.values()].sort((a, b) => a.meta.id.localeCompare(b.meta.id));
  const rulePath = (id: string): string => `rules/${slug(id)}.md`;

  // Association, both directions.
  const governedBy = new Map<string, ScannedRule[]>();
  const appliesTo = new Map<string, TypeConcept[]>();
  for (const rule of rules) {
    const targets = ruleAppliesTo(rule.source, concepts);
    appliesTo.set(rule.meta.id, targets);
    for (const target of targets) {
      if (!governedBy.has(target.resourceType)) governedBy.set(target.resourceType, []);
      governedBy.get(target.resourceType)!.push(rule);
    }
  }

  const docsUrl = `https://intentius.io/chant/lexicons/${input.name}/rules/`;
  const files: OkfFile[] = [];

  for (const concept of concepts) {
    const head = frontmatter({
      type: "resource-type",
      title: concept.className,
      description: truncate(
        oneLine(concept.description ?? `${input.name} resource type ${concept.resourceType}`),
        200,
      ),
      name: concept.className,
      lexicon: input.name,
      resource_type: concept.resourceType,
    });

    const body: string[] = [""];
    body.push(
      concept.description
        ? oneLine(concept.description)
        : `\`${concept.resourceType}\`, a resource type of the ${input.name} lexicon.`,
    );

    if (concept.properties.length > 0) {
      body.push("", "## Properties", "");
      for (const prop of concept.properties) body.push(propertyLine(prop));
    }

    if (concept.attributes.length > 0) {
      body.push("", "## Attributes", "");
      for (const attr of concept.attributes) body.push(`- \`${attr}\``);
    }

    const governing = governedBy.get(concept.resourceType) ?? [];
    if (governing.length > 0) {
      body.push("", "## Governed by", "");
      for (const rule of governing) {
        body.push(`- [${rule.meta.id}](/${rulePath(rule.meta.id)}): ${oneLine(rule.meta.description)}`);
      }
    }

    body.push("");
    files.push({ path: concept.path, content: head + body.join("\n") });
  }

  for (const rule of rules) {
    const head = frontmatter({
      type: rule.meta.type === "post-synth" ? "post-synth-check" : "lint-rule",
      title: rule.meta.id,
      description: truncate(oneLine(rule.meta.description), 200),
      id: rule.meta.id,
      severity: rule.meta.severity,
      category: rule.meta.category,
      lexicon: input.name,
      docs: docsUrl,
    });

    const body: string[] = ["", oneLine(rule.meta.description)];
    const targets = appliesTo.get(rule.meta.id) ?? [];
    if (targets.length > 0) {
      body.push("", "## Applies to", "");
      for (const target of targets) {
        body.push(`- [${target.className}](/${target.path})`);
      }
    }
    body.push("");
    files.push({ path: rulePath(rule.meta.id), content: head + body.join("\n") });
  }

  files.push({ path: "index.md", content: buildIndex(input.name, concepts, rules, rulePath) });
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

/**
 * The bundle-root `index.md`: resource types and rules as sections of linked
 * entries, `okf_version` its only frontmatter (spec §12).
 */
function buildIndex(
  name: string,
  concepts: TypeConcept[],
  rules: ScannedRule[],
  rulePath: (id: string) => string,
): string {
  const lines: string[] = ["---", `okf_version: '${OKF_VERSION}'`, "---", ""];

  if (concepts.length > 0) {
    lines.push("# Resource types", "");
    for (const concept of concepts) {
      lines.push(`* [${concept.className}](/${concept.path}) - ${concept.resourceType}`);
    }
    lines.push("");
  }

  if (rules.length > 0) {
    lines.push("# Rules", "");
    for (const rule of rules) {
      lines.push(`* [${rule.meta.id}](/${rulePath(rule.meta.id)}) - ${truncate(oneLine(rule.meta.description), 160)}`);
    }
    lines.push("");
  }

  if (concepts.length === 0 && rules.length === 0) {
    lines.push(`The ${name} lexicon declares no resource types or rules.`, "");
  }

  return lines.join("\n");
}
