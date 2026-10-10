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

interface Item {
  exportName: string;
  type: string;
  database?: string;
  name: string;
  ddl: string;
}

const TAG: Record<string, "database" | "table" | "view" | "dictionary" | "func"> = {
  [CLICKHOUSE_ENTITY_TYPES.database]: "database",
  [CLICKHOUSE_ENTITY_TYPES.table]: "table",
  [CLICKHOUSE_ENTITY_TYPES.view]: "view",
  [CLICKHOUSE_ENTITY_TYPES.materializedView]: "view",
  [CLICKHOUSE_ENTITY_TYPES.dictionary]: "dictionary",
  [CLICKHOUSE_ENTITY_TYPES.function]: "func",
};

/** A backquoted or double-quoted identifier, written bare when it can be and double-quoted otherwise. */
function identifierText(t: Token): string {
  if (t.kind !== "qident") return t.text;
  const name = unquote(t.text);
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

/** Text that sits inside a template literal: a backquote and `${` escaped. */
const templateSafe = (s: string) => s.replace(/\\(?=`|\$\{)/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");

/**
 * The template body for one statement, and the exports it references. A
 * qualified name of another imported object becomes `${export}`; the database
 * part of the statement's own name becomes the database's export.
 */
function templateBody(item: Item, byQualified: Map<string, Item>, dbExport: Map<string, string>): { body: string; refs: string[] } {
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
  const replace = new Map<number, { to: number; text: string; ref: string }>();
  for (let k = 0; k + 2 < sig.length; k++) {
    const a = tokens[sig[k]!]!;
    const dot = tokens[sig[k + 1]!]!;
    const b = tokens[sig[k + 2]!]!;
    if (!isName(a) || dot.kind !== "punct" || dot.text !== "." || !isName(b)) continue;
    const prev = tokens[sig[k - 1] ?? -1];
    if (prev?.kind === "punct" && prev.text === ".") continue;
    const db = unquote(a.text);
    const name = unquote(b.text);
    const inOwnName = own !== undefined && sig[k]! >= own.from && sig[k]! < own.to;
    const target = byQualified.get(`${db}.${name}`);
    if (!inOwnName && target && target !== item) {
      replace.set(sig[k]!, { to: sig[k + 2]! + 1, text: `\${${target.exportName}}`, ref: target.exportName });
      k += 2;
    } else if (inOwnName && dbExport.has(db)) {
      replace.set(sig[k]!, { to: sig[k]! + 1, text: `\${${dbExport.get(db)}}`, ref: dbExport.get(db)! });
      k += 2;
    }
  }
  let body = "";
  const refs: string[] = [];
  for (let i = 0; i < tokens.length; ) {
    const r = replace.get(i);
    if (r) {
      body += r.text;
      refs.push(r.ref);
      i = r.to;
      continue;
    }
    const t = tokens[i]!;
    body += t.kind === "qident" ? templateSafe(identifierText(t)) : templateSafe(t.text);
    i++;
  }
  return { body, refs };
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
      .filter((r) => TAG[r.type])
      .map((r) => ({
        exportName: r.logicalId,
        type: r.type,
        database: r.properties.database as string | undefined,
        name: String(r.properties.name),
        ddl: String(r.properties.ddl),
      }));
    if (items.length === 0) return [];

    const byQualified = new Map<string, Item>();
    const dbExport = new Map<string, string>();
    for (const it of items) {
      if (it.type === CLICKHOUSE_ENTITY_TYPES.database) dbExport.set(it.name, it.exportName);
      else if (it.database) byQualified.set(`${it.database}.${it.name}`, it);
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

    const tags = [...new Set(order.map((it) => TAG[it.type]!))].sort();
    const lines: string[] = [];
    if (this.header) lines.push(...this.header.split("\n").map((l) => `// ${l}`), "");
    lines.push(`import { ${tags.join(", ")} } from "@intentius/chant-lexicon-sql/clickhouse";`, "");
    for (const it of order) {
      lines.push(`export const ${it.exportName} = ${TAG[it.type]}\`\n  ${indent(bodies.get(it.exportName)!.body)}\`;`, "");
    }
    return [{ path: "schema.ts", content: `${lines.join("\n").trimEnd()}\n` }];
  }
}
