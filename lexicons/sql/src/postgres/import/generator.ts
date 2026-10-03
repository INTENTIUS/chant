/**
 * The import IR as TypeScript: one `schema.ts` holding every imported object
 * as a `schema`, `table`, `index`, `view`, `sequence`, `type`, `domain` or
 * `extension` declaration, in dependency order, with the references between
 * them interpolated, so the build orders them as the server did:
 *
 * - a qualified name of another imported object becomes `${export}`
 *   (`REFERENCES app.users(id)` is `REFERENCES ${users}(id)`, a type
 *   `app.order_status` is `${orderStatus}`);
 * - a sequence named in a `regclass` literal becomes the reference
 *   (`nextval('app.invoice_seq'::regclass)` is `nextval(${invoiceSeq})`);
 * - the schema part of the object's own name, wherever the name appears,
 *   becomes the schema's export (`CREATE TABLE ${appSchema}.users`);
 * - an extension's `WITH SCHEMA` names the schema's export.
 *
 * Columns stay text, as they do for ClickHouse (#3236): which relation a bare
 * column belongs to is the server's to resolve. One file, because the
 * references cross schemas freely.
 */

import type { GeneratedFile, TypeScriptGenerator } from "@intentius/chant/import/generator";
import type { TemplateIR } from "@intentius/chant/import/parser";
import { isTrivia, tokenizeText, type Token } from "../tokens";
import { identValue } from "../parser";
import { POSTGRES_ENTITY_TYPES } from "../entity-types";

interface Item {
  exportName: string;
  type: string;
  schema?: string;
  name: string;
  ddl: string;
}

const TAG: Record<string, string> = {
  [POSTGRES_ENTITY_TYPES.schema]: "schema",
  [POSTGRES_ENTITY_TYPES.table]: "table",
  [POSTGRES_ENTITY_TYPES.index]: "index",
  [POSTGRES_ENTITY_TYPES.view]: "view",
  [POSTGRES_ENTITY_TYPES.materializedView]: "view",
  [POSTGRES_ENTITY_TYPES.sequence]: "sequence",
  [POSTGRES_ENTITY_TYPES.enum]: "type",
  [POSTGRES_ENTITY_TYPES.domain]: "domain",
  [POSTGRES_ENTITY_TYPES.extension]: "extension",
};

/** Text that sits inside a template literal: a backquote and `${` escaped. */
const templateSafe = (s: string) => s.replace(/\\(?=`|\$\{)/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");

const isName = (t: Token | undefined) => t !== undefined && (t.kind === "ident" || t.kind === "qident");

/** `'app.invoice_seq'` as the qualified name it holds. */
function regclassName(t: Token): string | undefined {
  if (t.kind !== "string" || !/^'.*'$/s.test(t.text)) return undefined;
  const inner = t.text.slice(1, -1).replace(/''/g, "'");
  const pieces = inner.match(/"(?:[^"]|"")*"|[^.]+/g)?.map((p) => identValue(p)) ?? [];
  return pieces.length === 2 ? `${pieces[0]}.${pieces[1]}` : pieces.length === 1 ? `public.${pieces[0]}` : undefined;
}

function templateBody(item: Item, byQualified: Map<string, Item>, schemaExport: Map<string, string>): { body: string; refs: string[] } {
  const tokens = tokenizeText(item.ddl, 0);
  const sig: number[] = [];
  tokens.forEach((t, i) => {
    if (!isTrivia(t)) sig.push(i);
  });
  const replace = new Map<number, { to: number; text: string; ref: string }>();
  for (let k = 0; k < sig.length; k++) {
    const a = tokens[sig[k]!]!;
    const prev = tokens[sig[k - 1] ?? -1];
    if (prev?.kind === "punct" && prev.text === ".") continue;
    // A regclass literal: nextval('app.seq'::regclass) or 'app.t'::regclass.
    if (a.kind === "string" && tokens[sig[k + 1] ?? -1]?.text === "::" && tokens[sig[k + 2] ?? -1]?.text.toLowerCase() === "regclass") {
      const target = byQualified.get(regclassName(a) ?? "");
      if (target && target !== item) {
        const fn = tokens[sig[k - 2] ?? -1];
        const inCall = prev?.text === "(" && fn?.kind === "ident" && /^(nextval|currval|setval)$/i.test(fn.text);
        replace.set(sig[k]!, { to: inCall ? sig[k + 2]! + 1 : sig[k]! + 1, text: `\${${target.exportName}}`, ref: target.exportName });
        k += inCall ? 2 : 0;
        continue;
      }
    }
    const dot = tokens[sig[k + 1] ?? -1];
    const b = tokens[sig[k + 2] ?? -1];
    if (!isName(a) || dot?.kind !== "punct" || dot.text !== "." || !isName(b)) {
      // An extension's `WITH SCHEMA app`.
      if (item.type === POSTGRES_ENTITY_TYPES.extension && isName(a) && prev?.kind === "ident" && prev.text.toUpperCase() === "SCHEMA") {
        const s = schemaExport.get(identValue(a));
        if (s) replace.set(sig[k]!, { to: sig[k]! + 1, text: `\${${s}}`, ref: s });
      }
      continue;
    }
    const schema = identValue(a);
    const name = identValue(b);
    const self = schema === item.schema && name === item.name;
    const target = byQualified.get(`${schema}.${name}`);
    if (!self && target && target !== item) {
      replace.set(sig[k]!, { to: sig[k + 2]! + 1, text: `\${${target.exportName}}`, ref: target.exportName });
      k += 2;
    } else if (self && schemaExport.has(schema)) {
      replace.set(sig[k]!, { to: sig[k]! + 1, text: `\${${schemaExport.get(schema)}}`, ref: schemaExport.get(schema)! });
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
    body += templateSafe(tokens[i]!.text);
    i++;
  }
  return { body, refs };
}

const indent = (body: string) =>
  body
    .split("\n")
    .map((l, i) => (i === 0 || l.length === 0 ? l : `  ${l}`))
    .join("\n");

export class PostgresGenerator implements TypeScriptGenerator {
  readonly ownsLayout = true;

  constructor(private readonly header?: string) {}

  generate(ir: TemplateIR): GeneratedFile[] {
    const items: Item[] = ir.resources
      .filter((r) => TAG[r.type])
      .map((r) => ({
        exportName: r.logicalId,
        type: r.type,
        schema: r.properties.schema as string | undefined,
        name: String(r.properties.name),
        ddl: String(r.properties.ddl),
      }));
    if (items.length === 0) return [];

    const byQualified = new Map<string, Item>();
    const schemaExport = new Map<string, string>();
    for (const it of items) {
      if (it.type === POSTGRES_ENTITY_TYPES.schema) schemaExport.set(it.name, it.exportName);
      // An index is never referenced by name in another object's DDL.
      else if (it.schema && it.type !== POSTGRES_ENTITY_TYPES.index) byQualified.set(`${it.schema}.${it.name}`, it);
    }

    const bodies = new Map(items.map((it) => [it.exportName, templateBody(it, byQualified, schemaExport)]));
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
    lines.push(`import { ${tags.join(", ")} } from "@intentius/chant-lexicon-sql/postgres";`, "");
    for (const it of order) lines.push(`export const ${it.exportName} = ${TAG[it.type]}\`\n  ${indent(bodies.get(it.exportName)!.body)}\`;`, "");
    return [{ path: "schema.ts", content: `${lines.join("\n").trimEnd()}\n` }];
  }
}
