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
 * - an extension's `WITH SCHEMA`, a grant's `ON SCHEMA` and default
 *   privileges' `IN SCHEMA` name the schema's export;
 * - a grant's object becomes the object's export (`GRANT SELECT ON TABLE
 *   ${orders} TO reader`), a policy's table its table's.
 *
 * Columns stay text, as they do for ClickHouse (#3236): which relation a bare
 * column belongs to is the server's to resolve. One file, because the
 * references cross schemas freely.
 */

import type { GeneratedFile, TypeScriptGenerator } from "@intentius/chant/import/generator";
import type { TemplateIR } from "@intentius/chant/import/parser";
import { isTrivia, tokenizeText, type Token } from "../tokens";
import { identValue, parseStatements, type NameNode, type StatementNode } from "../parser";
import { POSTGRES_ENTITY_TYPES } from "../entity-types";

/** One object a template is written for, or (with no `ddl` read) one a template may reference. */
export interface PgTemplateItem {
  exportName: string;
  type: string;
  schema?: string;
  name: string;
  ddl: string;
}
type Item = PgTemplateItem;

/** A template's text: `parts` (template-literal safe) around one interpolation per entry of `refs`, an export name. */
export interface TemplateBody {
  parts: string[];
  refs: string[];
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
  [POSTGRES_ENTITY_TYPES.function]: "func",
  [POSTGRES_ENTITY_TYPES.procedure]: "procedure",
  [POSTGRES_ENTITY_TYPES.trigger]: "trigger",
  [POSTGRES_ENTITY_TYPES.policy]: "policy",
  [POSTGRES_ENTITY_TYPES.role]: "role",
  [POSTGRES_ENTITY_TYPES.grant]: "grant",
  [POSTGRES_ENTITY_TYPES.defaultPrivileges]: "grant",
};

/** The tag each entity type is declared with (`table`, `func`, ...). */
export const POSTGRES_TAG_OF: Readonly<Record<string, string>> = TAG;

/** Text that sits inside a template literal: a backquote and `${` escaped. */
const templateSafe = (s: string) => s.replace(/\\(?=`|\$\{)/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");

const isName = (t: Token | undefined) => t !== undefined && (t.kind === "ident" || t.kind === "qident");

/** `'app.invoice_seq'` as the qualified name it holds, or the bare name when unqualified. */
function regclassName(t: Token): string | undefined {
  if (t.kind !== "string" || !/^'.*'$/s.test(t.text)) return undefined;
  const inner = t.text.slice(1, -1).replace(/''/g, "'");
  const pieces = inner.match(/"(?:[^"]|"")*"|[^.]+/g)?.map((p) => identValue(p)) ?? [];
  return pieces.length === 2 ? `${pieces[0]}.${pieces[1]}` : pieces.length === 1 ? pieces[0] : undefined;
}

/** Words after which a bare name is a relation: `FROM t`, `JOIN t`, `REFERENCES t`. */
const RELATION_WORDS = new Set(["FROM", "JOIN", "REFERENCES"]);

/**
 * The tokens where a bare (unqualified) name is another object's: a column's
 * or a domain's type, the table of an index, trigger or policy, a trigger's
 * function, a grant's objects. A `FROM`, `JOIN` or `REFERENCES` before a
 * name is read off the tokens directly.
 */
function bareSpots(tokens: Token[]): Set<number> {
  const out = new Set<number>();
  let nodes: StatementNode[];
  try {
    nodes = parseStatements(tokens);
  } catch {
    return out;
  }
  const first = (from: number, to: number) => {
    for (let i = from; i < to; i++) if (!isTrivia(tokens[i]!)) return out.add(i);
    return out;
  };
  const name = (n: NameNode | undefined) => n && n.span.to - n.span.from > 0 && first(n.span.from, n.span.to);
  for (const node of nodes) {
    if (node.statement === "table") for (const c of node.columns) if (c.type) first(c.type.from, c.type.to);
    if (node.statement === "domain") first(node.type.from, node.type.to);
    if (node.statement === "index" || node.statement === "policy") name(node.table);
    if (node.statement === "trigger") {
      name(node.table);
      name(node.function);
    }
    if (node.statement === "grant") for (const o of node.objects) name(o.name);
  }
  return out;
}

function templateBody(item: Item, byQualified: Map<string, Item>, schemaExport: Map<string, string>): TemplateBody {
  const tokens = tokenizeText(item.ddl, 0);
  const sig: number[] = [];
  tokens.forEach((t, i) => {
    if (!isTrivia(t)) sig.push(i);
  });
  const spots = bareSpots(tokens);
  const replace = new Map<number, { to: number; ref: string }>();
  const isSelf = (target: Item) => target === item || (target.exportName === item.exportName && target.type === item.type);
  for (let k = 0; k < sig.length; k++) {
    const a = tokens[sig[k]!]!;
    const prev = tokens[sig[k - 1] ?? -1];
    if (prev?.kind === "punct" && prev.text === ".") continue;
    // A regclass literal: nextval('app.seq'::regclass) or 'app.t'::regclass.
    if (a.kind === "string" && tokens[sig[k + 1] ?? -1]?.text === "::" && tokens[sig[k + 2] ?? -1]?.text.toLowerCase() === "regclass") {
      const held = regclassName(a) ?? "";
      // An unqualified name is the object in `public`, as the server's own printing has it, else the unqualified object of that name.
      const target = (!held.includes(".") ? byQualified.get(`public.${held}`) : undefined) ?? byQualified.get(held);
      if (target && !isSelf(target)) {
        const fn = tokens[sig[k - 2] ?? -1];
        const inCall = prev?.text === "(" && fn?.kind === "ident" && /^(nextval|currval|setval)$/i.test(fn.text);
        replace.set(sig[k]!, { to: inCall ? sig[k + 2]! + 1 : sig[k]! + 1, ref: target.exportName });
        k += inCall ? 2 : 0;
        continue;
      }
    }
    const dot = tokens[sig[k + 1] ?? -1];
    const b = tokens[sig[k + 2] ?? -1];
    if (!isName(a) || dot?.kind !== "punct" || dot.text !== "." || !isName(b)) {
      // An extension's `WITH SCHEMA app`, a grant's `ON SCHEMA app`, default privileges' `IN SCHEMA app`.
      const bySchemaWord = item.type === POSTGRES_ENTITY_TYPES.extension || item.type === POSTGRES_ENTITY_TYPES.grant || item.type === POSTGRES_ENTITY_TYPES.defaultPrivileges;
      if (bySchemaWord && isName(a) && prev?.kind === "ident" && prev.text.toUpperCase() === "SCHEMA") {
        const s = schemaExport.get(identValue(a));
        if (s) replace.set(sig[k]!, { to: sig[k]! + 1, ref: s });
        continue;
      }
      // A bare name where an object is named: `REFERENCES users`, `ON users`, a column of type `status`.
      const bare = isName(a) && (spots.has(sig[k]!) || (prev?.kind === "ident" && RELATION_WORDS.has(prev.text.toUpperCase())));
      const target = bare ? byQualified.get(identValue(a)) : undefined;
      if (target && !isSelf(target)) replace.set(sig[k]!, { to: sig[k]! + 1, ref: target.exportName });
      continue;
    }
    const schema = identValue(a);
    const name = identValue(b);
    const self = schema === item.schema && name === item.name;
    const target = byQualified.get(`${schema}.${name}`);
    if (!self && target && !isSelf(target)) {
      replace.set(sig[k]!, { to: sig[k + 2]! + 1, ref: target.exportName });
      k += 2;
    } else if (self && schemaExport.has(schema)) {
      replace.set(sig[k]!, { to: sig[k]! + 1, ref: schemaExport.get(schema)! });
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
    parts[parts.length - 1] += templateSafe(tokens[i]!.text);
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
 *
 * A name is a reference where it is qualified (`app.users`), or bare where an
 * object is named (`REFERENCES users`, `FROM users`, an index's table, a
 * column's type) and an unqualified object has that name.
 */
export function postgresTemplates(items: readonly Item[], targets: readonly Item[] = items): { order: Item[]; bodies: Map<string, TemplateBody> } {
  const byQualified = new Map<string, Item>();
  const schemaExport = new Map<string, string>();
  for (const it of targets) {
    if (it.type === POSTGRES_ENTITY_TYPES.schema) schemaExport.set(it.name, it.exportName);
    // An index or a trigger is never referenced by name in another object's DDL.
    else if (it.type !== POSTGRES_ENTITY_TYPES.index && it.type !== POSTGRES_ENTITY_TYPES.trigger && it.type !== POSTGRES_ENTITY_TYPES.policy && it.type !== POSTGRES_ENTITY_TYPES.grant && it.type !== POSTGRES_ENTITY_TYPES.defaultPrivileges && it.type !== POSTGRES_ENTITY_TYPES.role && it.type !== POSTGRES_ENTITY_TYPES.extension) {
      byQualified.set(it.schema ? `${it.schema}.${it.name}` : it.name, it);
    }
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
  return { order, bodies };
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

    const { order, bodies } = postgresTemplates(items);

    const tags = [...new Set(order.map((it) => TAG[it.type]!))].sort();
    const lines: string[] = [];
    if (this.header) lines.push(...this.header.split("\n").map((l) => `// ${l}`), "");
    lines.push(`import { ${tags.join(", ")} } from "@intentius/chant-lexicon-sql/postgres";`, "");
    for (const it of order) lines.push(`export const ${it.exportName} = ${TAG[it.type]}\`\n  ${indent(bodyText(bodies.get(it.exportName)!))}\`;`, "");
    return [{ path: "schema.ts", content: `${lines.join("\n").trimEnd()}\n` }];
  }
}
