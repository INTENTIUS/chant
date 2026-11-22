/**
 * MySQL DDL into the import IR, and back out as `database`, `table` and
 * `view` declarations (#5449).
 *
 * `chant import --from <env>` reads each object's `SHOW CREATE`
 * (`./live-export.ts`) and `chant import schema.sql` reads a file of
 * statements (`../../files/mysql.ts`); both arrive here as statements. The
 * declaration is the statement itself, with three changes:
 *
 * - a name of another imported object becomes a reference to its export: a
 *   qualified `shop.users`, or a bare name after `FROM`, `JOIN` or
 *   `REFERENCES` that an object in the same database has, so dependency order
 *   survives; the database part of an object's own name becomes a reference
 *   to the database's export;
 * - a backquoted name that needs no quoting is written bare, and so the
 *   template has few backquotes to escape;
 * - from a server, what the server adds and an author would not write is
 *   left out (`stripServerDefaults`): the `AUTO_INCREMENT` counter, a
 *   view's `ALGORITHM = UNDEFINED`, `DEFINER` and `SQL SECURITY DEFINER`,
 *   and `DEFAULT NULL` on a nullable column.
 *
 * Columns written by name inside a view's query stay text: which table a
 * bare name belongs to is the server's to resolve.
 */

import type { GeneratedFile, TypeScriptGenerator } from "@intentius/chant/import/generator";
import type { ResourceIR, TemplateIR } from "@intentius/chant/import/parser";
import { relationKey } from "../../core/typed";
import { isTrivia, tokenizeText, unquote, type Token } from "../tokens";
import { parseMysqlCreate, type MysqlCreateNode } from "../parser";
import { MYSQL_ENTITY_TYPES, MYSQL_TAG_OF, type MysqlEntityType } from "../entities";
import { RESERVED_WORDS } from "../../generated/mysql";
import { unversioned } from "../canonical";

export interface ImportedMysqlObject {
  type: MysqlEntityType;
  database?: string;
  name: string;
  /** The CREATE statement. */
  ddl: string;
}

/** One object a template is written for, or one a template may reference. */
export interface MysqlTemplateItem {
  exportName: string;
  type: string;
  database?: string;
  name: string;
  ddl: string;
}
type Item = MysqlTemplateItem;

/** A template's text: `parts` (template-literal safe) around one interpolation per entry of `refs`, an export name. */
export interface TemplateBody {
  parts: string[];
  refs: string[];
}

const JS_RESERVED = new Set(
  "break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await".split(" "),
);

function camel(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length === 0) return "object";
  const s = words.map((w, i) => (i === 0 ? w[0]!.toLowerCase() + w.slice(1) : w[0]!.toUpperCase() + w.slice(1))).join("");
  return /^[0-9]/.test(s) ? `t${s}` : s;
}

/**
 * Export names: a table or view is its name in camel case, prefixed with its
 * database when two databases share a name; a database is its name with `Db`
 * after it.
 */
export function mysqlExportNames(objects: readonly { type: string; database?: string; name: string }[]): string[] {
  const count = new Map<string, number>();
  for (const o of objects) if (o.type !== MYSQL_ENTITY_TYPES.database) count.set(o.name, (count.get(o.name) ?? 0) + 1);
  const used = new Set<string>();
  return objects.map((o) => {
    let base = o.type === MYSQL_ENTITY_TYPES.database ? `${camel(o.name)}Db` : (count.get(o.name) ?? 0) > 1 && o.database ? camel(`${o.database}_${o.name}`) : camel(o.name);
    if (JS_RESERVED.has(base)) base = `${base}Table`;
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base}${i}`;
    used.add(name);
    return name;
  });
}

const TYPE_OF: Record<MysqlCreateNode["statement"], MysqlEntityType | undefined> = {
  database: MYSQL_ENTITY_TYPES.database,
  table: MYSQL_ENTITY_TYPES.table,
  view: MYSQL_ENTITY_TYPES.view,
  index: undefined,
};

/** A statement's kind and name; `defaultDatabase` qualifies a bare table or view name. Throws the parser's error. */
export function describeMysqlStatement(ddl: string, defaultDatabase?: string): ImportedMysqlObject {
  const tokens = tokenizeText(ddl, 0);
  const node = parseMysqlCreate(tokens);
  const type = TYPE_OF[node.statement];
  if (!type) throw new Error("a CREATE INDEX is read into its table");
  const parts = tokens
    .slice((node as { name: { from: number } }).name.from, (node as { name: { to: number } }).name.to)
    .filter((t) => !isTrivia(t) && !(t.kind === "punct" && t.text === "."))
    .map((t) => unquote(t.text));
  if (node.statement === "database") return { type, name: parts[parts.length - 1] ?? "", ddl };
  const database = parts.length >= 2 ? parts[parts.length - 2] : defaultDatabase;
  return { type, ...(database !== undefined ? { database } : {}), name: parts[parts.length - 1] ?? "", ddl };
}

/** Remove the token range [from, to) from `ddl`'s tokens, and any space it leaves doubled. */
function cut(tokens: Token[], ranges: Array<[number, number]>): string {
  const drop = new Set<number>();
  for (const [from, to] of ranges) for (let i = from; i < to; i++) drop.add(i);
  return tokens
    .filter((_, i) => !drop.has(i))
    .map((t) => t.text)
    .join("")
    .replace(/(\S)[ \t]{2,}/g, "$1 ")
    .replace(/[ \t]+(,|\n)/g, "$1")
    .replace(/\( +/g, "(")
    .trim();
}

/** Leave out what the server adds and an author would not write. Returns the statement as it was when it does not parse. */
export function stripServerDefaults(ddl: string): string {
  const text = unversioned(ddl);
  const tokens = tokenizeText(text, 0);
  let node: MysqlCreateNode;
  try {
    node = parseMysqlCreate(tokens);
  } catch {
    return ddl;
  }
  const sig: number[] = [];
  tokens.forEach((t, i) => {
    if (!isTrivia(t)) sig.push(i);
  });
  const ranges: Array<[number, number]> = [];
  const word = (i: number, ...w: string[]) => tokens[i]?.kind === "ident" && w.includes(tokens[i]!.text.toUpperCase());
  if (node.statement === "table") {
    const auto = node.options.find((o) => o.key === "AUTO_INCREMENT");
    if (auto) {
      let start = auto.value.from - 1;
      while (start > 0 && !word(start, "AUTO_INCREMENT")) start--;
      ranges.push([start, auto.value.to]);
    }
    // `DEFAULT NULL` on a column that can be NULL is no default at all.
    for (let k = 0; k + 1 < sig.length; k++) {
      if (word(sig[k]!, "DEFAULT") && word(sig[k + 1]!, "NULL")) ranges.push([sig[k]!, sig[k + 1]! + 1]);
    }
  }
  if (node.statement === "view") {
    // `ALGORITHM=UNDEFINED DEFINER=... SQL SECURITY DEFINER` between CREATE and VIEW.
    const viewAt = sig.findIndex((i) => word(i, "VIEW"));
    let k = 1;
    while (k < viewAt) {
      if (word(sig[k]!, "ALGORITHM") && word(sig[k + 2]!, "UNDEFINED")) {
        ranges.push([sig[k]!, sig[k + 2]! + 1]);
        k += 3;
      } else if (word(sig[k]!, "DEFINER")) {
        let end = k + 2;
        if (tokens[sig[end + 1] ?? -1]?.text === "@") end += 2;
        ranges.push([sig[k]!, sig[end]! + 1]);
        k = end + 1;
      } else if (word(sig[k]!, "SQL") && word(sig[k + 2]!, "DEFINER")) {
        ranges.push([sig[k]!, sig[k + 2]! + 1]);
        k += 3;
      } else k++;
    }
  }
  return ranges.length === 0 ? text.trim() : cut(tokens, ranges);
}

/** The IR for a set of objects. */
export function mysqlObjectsToIR(objects: readonly ImportedMysqlObject[], warnings: string[] = []): TemplateIR {
  const names = mysqlExportNames(objects);
  const resources: ResourceIR[] = objects.map((o, i) => ({
    logicalId: names[i]!,
    type: o.type,
    properties: { ...(o.database ? { database: o.database } : {}), name: o.name, ddl: o.ddl },
  }));
  return { resources, parameters: [], ...(warnings.length ? { warnings } : {}) };
}

const RESERVED: ReadonlySet<string> = RESERVED_WORDS as ReadonlySet<string>;

/** A backquoted name, bare when it can be. */
function identifierText(t: Token): string {
  if (t.kind !== "qident") return t.text;
  const name = unquote(t.text);
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !RESERVED.has(name.toUpperCase()) ? name : t.text;
}

/** Text that sits inside a template literal: a backquote and `${` escaped. */
export const templateSafe = (s: string): string => s.replace(/\\(?=`|\$\{)/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");

/** Words after which a bare name is a table or view. */
const RELATION_WORDS = new Set(["FROM", "JOIN", "REFERENCES"]);

function templateBody(item: Item, byQualified: Map<string, Item>, dbExport: Map<string, string>): TemplateBody {
  const tokens = tokenizeText(item.ddl, 0);
  let own: { from: number; to: number } | undefined;
  try {
    const node = parseMysqlCreate(tokens) as { name?: { from: number; to: number } };
    own = node.name;
  } catch {
    own = undefined;
  }
  const sig: number[] = [];
  tokens.forEach((t, i) => {
    if (!isTrivia(t)) sig.push(i);
  });
  const isName = (t: Token | undefined) => t !== undefined && (t.kind === "ident" || t.kind === "qident");
  const isSelf = (target: Item) => target.exportName === item.exportName;
  const inOwn = (i: number) => own !== undefined && i >= own.from && i < own.to;
  const replace = new Map<number, { to: number; ref: string }>();
  for (let k = 0; k < sig.length; k++) {
    const a = tokens[sig[k]!]!;
    const dot = tokens[sig[k + 1] ?? -1];
    const b = tokens[sig[k + 2] ?? -1];
    const prev = tokens[sig[k - 1] ?? -1];
    if (prev?.kind === "punct" && prev.text === ".") continue;
    if (!isName(a)) continue;
    if (dot?.kind === "punct" && dot.text === "." && isName(b)) {
      const db = unquote(a.text);
      const name = unquote(b!.text);
      const target = byQualified.get(`${db}.${name}`);
      if (!inOwn(sig[k]!) && target && !isSelf(target)) {
        replace.set(sig[k]!, { to: sig[k + 2]! + 1, ref: target.exportName });
        k += 2;
      } else if (inOwn(sig[k]!) && dbExport.has(db)) {
        replace.set(sig[k]!, { to: sig[k]! + 1, ref: dbExport.get(db)! });
        k += 2;
      }
      continue;
    }
    const bare = !inOwn(sig[k]!) && prev?.kind === "ident" && RELATION_WORDS.has(prev.text.toUpperCase());
    const target = bare && item.database !== undefined ? byQualified.get(`${item.database}.${unquote(a.text)}`) : undefined;
    if (target && !isSelf(target)) replace.set(sig[k]!, { to: sig[k]! + 1, ref: target.exportName });
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
    parts[parts.length - 1] += templateSafe(t.kind === "qident" ? identifierText(t) : t.text);
    i++;
  }
  return { parts, refs };
}

/** A template body as the text between the backquotes. */
export const bodyText = (body: TemplateBody): string => body.parts.map((p, i) => (i === 0 ? p : `\${${body.refs[i - 1]}}${p}`)).join("");

/**
 * The template of each object in `items`, with references to `targets`
 * interpolated, and the items in the order a file declares them: each after
 * what it references.
 */
export function mysqlTemplates(items: readonly Item[], targets: readonly Item[] = items): { order: Item[]; bodies: Map<string, TemplateBody> } {
  const byQualified = new Map<string, Item>();
  const dbExport = new Map<string, string>();
  for (const it of targets) {
    if (it.type === MYSQL_ENTITY_TYPES.database) dbExport.set(it.name, it.exportName);
    else if (it.database !== undefined) byQualified.set(`${it.database}.${it.name}`, it);
  }
  const bodies = new Map(items.map((it) => [it.exportName, templateBody(it, byQualified, dbExport)]));
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
  return body
    .split("\n")
    .map((l, i) => (i === 0 || l.length === 0 ? l : `  ${l}`))
    .join("\n");
}

export class MysqlGenerator implements TypeScriptGenerator {
  readonly ownsLayout = true;

  constructor(private readonly header?: string) {}

  generate(ir: TemplateIR): GeneratedFile[] {
    const items: Item[] = ir.resources
      .filter((r) => MYSQL_TAG_OF[r.type])
      .map((r) => ({
        exportName: r.logicalId,
        type: r.type,
        ...(r.properties.database !== undefined ? { database: String(r.properties.database) } : {}),
        name: String(r.properties.name),
        ddl: String(r.properties.ddl),
      }));
    if (items.length === 0) return [];
    const { order, bodies } = mysqlTemplates(items);
    const tags = [...new Set(order.map((it) => MYSQL_TAG_OF[it.type]!))].sort();
    const lines: string[] = [];
    if (this.header) lines.push(...this.header.split("\n").map((l) => `// ${l}`), "");
    lines.push(`import { ${tags.join(", ")} } from "@intentius/chant-lexicon-sql/mysql";`, "");
    for (const it of order) {
      const typeArg = it.type === MYSQL_ENTITY_TYPES.database ? "" : `<${JSON.stringify(relationKey(it))}>`;
      lines.push(`export const ${it.exportName} = ${MYSQL_TAG_OF[it.type]}${typeArg}\`\n  ${indent(bodyText(bodies.get(it.exportName)!))}\`;`, "");
    }
    return [{ path: "schema.ts", content: `${lines.join("\n").trimEnd()}\n` }];
  }
}
