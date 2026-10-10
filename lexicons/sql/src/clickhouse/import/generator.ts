/**
 * The import IR as TypeScript: one `schema.ts` holding every imported
 * object as a `database`, `table` or `view` declaration, in dependency order,
 * with references between them interpolated. One file because the references
 * cross databases freely, and declarations in one file reference each other
 * without import cycles.
 */

import type { GeneratedFile, TypeScriptGenerator } from "@intentius/chant/import/generator";
import type { TemplateIR } from "@intentius/chant/import/parser";
import { isTrivia, tokenizeText, type Token } from "../tokens";
import { parseCreate, unquote, type CreateNode } from "../parser";
import { CLICKHOUSE_ENTITY_TYPES } from "../entities";

/** One object a template is written for, or one a template may reference. */
export interface ChTemplateItem {
  exportName: string;
  type: string;
  database?: string;
  name: string;
  ddl: string;
}
type Item = ChTemplateItem;

/** A template's text: `parts` (template-literal safe) around one interpolation per entry of `refs`, an export name. */
export interface TemplateBody {
  parts: string[];
  refs: string[];
}

export const CLICKHOUSE_TAG_OF: Readonly<Record<string, "database" | "table" | "view" | "dictionary" | "func" | "user" | "role" | "policy" | "grant">> = {
  [CLICKHOUSE_ENTITY_TYPES.database]: "database",
  [CLICKHOUSE_ENTITY_TYPES.table]: "table",
  [CLICKHOUSE_ENTITY_TYPES.view]: "view",
  [CLICKHOUSE_ENTITY_TYPES.materializedView]: "view",
  [CLICKHOUSE_ENTITY_TYPES.dictionary]: "dictionary",
  [CLICKHOUSE_ENTITY_TYPES.function]: "func",
  // Read from `.sql` files (#3711).
  [CLICKHOUSE_ENTITY_TYPES.user]: "user",
  [CLICKHOUSE_ENTITY_TYPES.role]: "role",
  [CLICKHOUSE_ENTITY_TYPES.rowPolicy]: "policy",
  [CLICKHOUSE_ENTITY_TYPES.grant]: "grant",
};

/** A backquoted or double-quoted identifier, written bare when it can be and double-quoted otherwise. */
function identifierText(t: Token): string {
  if (t.kind !== "qident") return t.text;
  const name = unquote(t.text);
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

/** Text that sits inside a template literal: a backquote and `${` escaped. */
const templateSafe = (s: string) => s.replace(/\\(?=`|\$\{)/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");

/** Words after which a bare name is a relation: `FROM t`, `JOIN t`, a materialized view's `TO t`. */
const RELATION_WORDS = new Set(["FROM", "JOIN", "TO"]);

/**
 * The template body for one statement, and the exports it references. A
 * qualified name of another object becomes `${export}`, and so does a bare
 * name after `FROM`, `JOIN` or `TO` that an unqualified object has; the
 * database part of the statement's own name becomes the database's export.
 */
function templateBody(item: Item, byQualified: Map<string, Item>, dbExport: Map<string, string>): TemplateBody {
  const tokens = tokenizeText(item.ddl, 0);
  let node: CreateNode | undefined;
  try {
    node = parseCreate(tokens);
  } catch {
    node = undefined;
  }
  const own = node ? { from: node.name.from, to: node.name.to } : undefined;
  const sig: number[] = [];
  tokens.forEach((t, i) => {
    if (!isTrivia(t)) sig.push(i);
  });
  const isName = (t: Token | undefined) => t !== undefined && (t.kind === "ident" || t.kind === "qident");
  const isSelf = (target: Item) => target === item || target.exportName === item.exportName;
  const replace = new Map<number, { to: number; ref: string }>();
  for (let k = 0; k < sig.length; k++) {
    const a = tokens[sig[k]!]!;
    const dot = tokens[sig[k + 1] ?? -1];
    const b = tokens[sig[k + 2] ?? -1];
    const prev = tokens[sig[k - 1] ?? -1];
    if (prev?.kind === "punct" && prev.text === ".") continue;
    if (!isName(a) || dot?.kind !== "punct" || dot.text !== "." || !isName(b)) {
      const inOwnName = own !== undefined && sig[k]! >= own.from && sig[k]! < own.to;
      const bare = isName(a) && !inOwnName && prev?.kind === "ident" && RELATION_WORDS.has(prev.text.toUpperCase());
      const target = bare ? byQualified.get(unquote(a.text)) : undefined;
      if (target && !isSelf(target)) replace.set(sig[k]!, { to: sig[k]! + 1, ref: target.exportName });
      continue;
    }
    const db = unquote(a.text);
    const name = unquote(b!.text);
    const inOwnName = own !== undefined && sig[k]! >= own.from && sig[k]! < own.to;
    const target = byQualified.get(`${db}.${name}`);
    if (!inOwnName && target && !isSelf(target)) {
      replace.set(sig[k]!, { to: sig[k + 2]! + 1, ref: target.exportName });
      k += 2;
    } else if (inOwnName && dbExport.has(db)) {
      replace.set(sig[k]!, { to: sig[k]! + 1, ref: dbExport.get(db)! });
      k += 2;
    }
  }
  const parts: string[] = [""];
  const refs: string[] = [];
  for (let i = 0; i < tokens.length; ) {
    const r = replace.get(i);
    if (r) {
      refs.push(r.ref);
      parts.push("");
      i = r.to;
      continue;
    }
    const t = tokens[i]!;
    parts[parts.length - 1] += t.kind === "qident" ? templateSafe(identifierText(t)) : templateSafe(t.text);
    i++;
  }
  return { parts, refs };
}

/** A template body as the text between the backquotes. */
export const bodyText = (body: TemplateBody): string => body.parts.map((p, i) => (i === 0 ? p : `\${${body.refs[i - 1]}}${p}`)).join("");

/**
 * The template of each object in `items`, with the references to `targets`
 * (the items themselves, and any object declared elsewhere that they may
 * name) interpolated, and the items in the order a file declares them: each
 * after what it references.
 */
export function clickhouseTemplates(items: readonly Item[], targets: readonly Item[] = items): { order: Item[]; bodies: Map<string, TemplateBody> } {
  const byQualified = new Map<string, Item>();
  const dbExport = new Map<string, string>();
  for (const it of targets) {
    if (it.type === CLICKHOUSE_ENTITY_TYPES.database) dbExport.set(it.name, it.exportName);
    // A function is called, never named after FROM, JOIN or TO; a row policy and a grant are never named at all.
    else if (it.type !== CLICKHOUSE_ENTITY_TYPES.function && it.type !== CLICKHOUSE_ENTITY_TYPES.rowPolicy && it.type !== CLICKHOUSE_ENTITY_TYPES.grant) byQualified.set(it.database ? `${it.database}.${it.name}` : it.name, it);
  }
  const bodies = new Map(items.map((it) => [it.exportName, templateBody(it, byQualified, dbExport)]));
  // Declarations reference each other in one file, so each comes after what it references.
  const order: Item[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const byExport = new Map(items.map((it) => [it.exportName, it]));
  const visit = (it: Item) => {
    if (done.has(it.exportName) || visiting.has(it.exportName)) return;
    visiting.add(it.exportName);
    for (const ref of bodies.get(it.exportName)!.refs) {
      const dep = byExport.get(ref);
      if (dep) visit(dep);
    }
    visiting.delete(it.exportName);
    done.add(it.exportName);
    order.push(it);
  };
  for (const it of items) visit(it);
  return { order, bodies };
}

function indent(body: string): string {
  const lines = body.split("\n");
  return lines.map((l, i) => (i === 0 || l.length === 0 ? l : `  ${l}`)).join("\n");
}

export class ClickHouseGenerator implements TypeScriptGenerator {
  readonly ownsLayout = true;

  constructor(private readonly header?: string) {}

  generate(ir: TemplateIR): GeneratedFile[] {
    const items: Item[] = ir.resources
      .filter((r) => CLICKHOUSE_TAG_OF[r.type])
      .map((r) => ({
        exportName: r.logicalId,
        type: r.type,
        database: r.properties.database as string | undefined,
        name: String(r.properties.name),
        ddl: String(r.properties.ddl),
      }));
    if (items.length === 0) return [];

    const { order, bodies } = clickhouseTemplates(items);

    const tags = [...new Set(order.map((it) => CLICKHOUSE_TAG_OF[it.type]!))].sort();
    const lines: string[] = [];
    if (this.header) lines.push(...this.header.split("\n").map((l) => `// ${l}`), "");
    lines.push(`import { ${tags.join(", ")} } from "@intentius/chant-lexicon-sql/clickhouse";`, "");
    for (const it of order) {
      lines.push(`export const ${it.exportName} = ${CLICKHOUSE_TAG_OF[it.type]}\`\n  ${indent(bodyText(bodies.get(it.exportName)!))}\`;`, "");
    }
    return [{ path: "schema.ts", content: `${lines.join("\n").trimEnd()}\n` }];
  }
}
