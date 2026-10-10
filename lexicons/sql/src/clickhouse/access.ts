/**
 * ClickHouse access control as declarations (#3682): users, roles, row
 * policies and grants.
 *
 * Each is a statement the server keeps outside any table: `CREATE USER`,
 * `CREATE ROLE`, `CREATE ROW POLICY` and `GRANT`. This module parses them
 * (the tags in `./entities.ts`, the lint rule, the plan), reduces each to
 * the fields a plan compares, and writes the statements that make a change.
 *
 * What a declaration owns and what the environment owns:
 *
 * - A password is the environment's. `IDENTIFIED BY` is refused in a
 *   declaration (only `ssh_key BY KEY`, a public key, is taken), so no
 *   secret is ever in a build. A user declared with no `IDENTIFIED` clause
 *   is compared without it, and is not created by chant: create it with its
 *   password, and the next apply manages the rest of it. A user declared
 *   with a method that holds no secret (`ssl_certificate`, `ldap`,
 *   `kerberos`, `http`, `ssh_key`, `no_password`) is created and kept so.
 * - Grants are compared per grantee, for each grantee the build declares a
 *   grant to: every grant declaration naming it adds up to its complete
 *   list, and a grant made by hand to it is revoked. A grant another one
 *   covers (`SELECT ON db.t` beside `SELECT ON db.*`) is folded away, as the
 *   server folds it.
 * - None of these objects has a comment, so none carries chant's ownership
 *   marker. A plan reads only the ones the build declares; chant creates and
 *   changes them, and never drops one.
 */

import { isTrivia, tokenizeText, type Token } from "./tokens";
import { kw, SqlCursor, type Span } from "../core/cursor";
import { unquote } from "./parser";

export type AccessStatement = "user" | "role" | "rowPolicy" | "grant";

/** One parsed access statement. Clause spans are token spans, keywords left out. */
export interface AccessNode {
  statement: AccessStatement;
  orReplace: boolean;
  ifNotExists: boolean;
  /** A user's, role's or row policy's name; none for a grant. */
  name?: Span;
  onCluster?: Span;
  /** A row policy's table, `[db.]table`. */
  table?: Span;
  /** Each clause after its keywords, by key: `identified`, `host`, `defaultRole`, `defaultDatabase`, `grantees`, `settings`, `validUntil`, `as`, `for`, `using`, `to`. */
  clauses: Partial<Record<string, Span>>;
  /** A grant's privileges or roles, one span each. */
  items: Span[];
  /** A grant's `ON` target; none for a grant of roles. */
  target?: Span;
  /** A grant's grantees. */
  grantees: Span[];
  /** `WITH GRANT OPTION` or `WITH ADMIN OPTION`. */
  withOption?: "GRANT" | "ADMIN";
  /** A `REVOKE` line, as `SHOW GRANTS` prints a partial revoke. Never declared. */
  revoke?: boolean;
}

const isName = (t: Token | undefined): boolean => t !== undefined && (t.kind === "ident" || t.kind === "qident" || t.kind === "ref");

class AccessParser extends SqlCursor {
  private name(what: string): Span {
    const t = this.next();
    if (!isName(t)) this.fail(`expected ${what}`, t);
    const i = this.idx(-1);
    return { from: i, to: i + 1, refs: t.kind === "ref" ? [t.part] : [] };
  }

  /** `name` or `db.name`, a `*` in either place. */
  private qualified(): Span {
    const from = this.idx();
    const refs: number[] = [];
    const one = () => {
      const t = this.next();
      if (!(isName(t) || (t.kind === "op" && t.text === "*"))) this.fail("expected a name", t);
      if (t.kind === "ref") refs.push(t.part);
    };
    one();
    while (this.isPunct(".")) {
      this.p++;
      one();
    }
    return this.span(from, refs);
  }

  private orReplace = false;
  private ifNotExists = false;

  /** `IF NOT EXISTS` or `OR REPLACE`, which ClickHouse takes after USER, ROLE and ROW POLICY. */
  private head(): void {
    if (kw(this.peek(), "IF") && kw(this.peek(1), "NOT") && kw(this.peek(2), "EXISTS")) {
      this.p += 3;
      this.ifNotExists = true;
    } else if (kw(this.peek(), "OR") && kw(this.peek(1), "REPLACE")) {
      this.p += 2;
      this.orReplace = true;
    }
  }

  private onClusterClause(): Span | undefined {
    if (kw(this.peek(), "ON") && kw(this.peek(1), "CLUSTER")) {
      this.p += 2;
      const from = this.idx();
      const t = this.next();
      if (!isName(t) && t.kind !== "string") this.fail("expected a cluster name", t);
      return this.span(from, t.kind === "ref" ? [t.part] : []);
    }
    return undefined;
  }

  /** Clauses in any order: each starts with one of `starts` (a keyword sequence) and runs to the next clause. */
  private clauses(starts: Record<string, string[]>, node: AccessNode): void {
    const stopWords = [...new Set(Object.values(starts).map((w) => w[0]!))];
    for (;;) {
      if (this.atEnd()) return;
      const hit = Object.entries(starts).find(([, words]) => words.every((w, i) => kw(this.peek(i), w)));
      if (!hit) this.fail(`unexpected ${this.peek()?.text}: expected ${Object.values(starts).map((w) => w.join(" ")).join(", ")}`);
      const [key, words] = hit;
      this.p += words.length;
      if (node.clauses[key]) this.fail(`${words.join(" ")} is written twice`);
      // `NOT IDENTIFIED` has no value; every other clause has one.
      node.clauses[key] = key === "notIdentified" ? { from: this.idx(-1), to: this.idx(-1) + 1, refs: [] } : this.expr(stopWords, false);
    }
  }

  parse(): AccessNode {
    if (this.accept("GRANT")) return this.grant(false);
    if (this.accept("REVOKE")) return this.grant(true);
    this.expect("CREATE");
    const node = (statement: AccessStatement): AccessNode => ({ statement, orReplace: this.orReplace, ifNotExists: this.ifNotExists, clauses: {}, items: [], grantees: [] });
    if (this.accept("USER")) {
      this.head();
      const n = node("user");
      n.name = this.name("a user name");
      if (this.isPunct(",")) this.fail("declare one user per template");
      n.onCluster = this.onClusterClause();
      this.clauses(
        {
          notIdentified: ["NOT", "IDENTIFIED"],
          identified: ["IDENTIFIED"],
          host: ["HOST"],
          validUntil: ["VALID", "UNTIL"],
          in: ["IN"],
          defaultRole: ["DEFAULT", "ROLE"],
          defaultDatabase: ["DEFAULT", "DATABASE"],
          grantees: ["GRANTEES"],
          settings: ["SETTINGS"],
        },
        n,
      );
      refusePassword(this, this.tokens, n);
      return n;
    }
    if (this.accept("ROLE")) {
      this.head();
      const n = node("role");
      n.name = this.name("a role name");
      if (this.isPunct(",")) this.fail("declare one role per template");
      n.onCluster = this.onClusterClause();
      this.clauses({ in: ["IN"], settings: ["SETTINGS"] }, n);
      return n;
    }
    if (this.accept("ROW")) this.expect("POLICY");
    else if (!this.accept("POLICY")) this.fail("expected USER, ROLE or ROW POLICY");
    this.head();
    const n = node("rowPolicy");
    n.name = this.name("a policy name");
    n.onCluster = this.onClusterClause();
    this.expect("ON");
    n.table = this.qualified();
    if (this.isPunct(",")) this.fail("declare one row policy, on one table, per template");
    this.clauses({ as: ["AS"], for: ["FOR"], using: ["USING"], to: ["TO"] }, n);
    if (!n.clauses.using) this.fail("expected USING and the policy's condition");
    return n;
  }

  private grant(revoke: boolean): AccessNode {
    const n: AccessNode = { statement: "grant", orReplace: false, ifNotExists: false, clauses: {}, items: [], grantees: [], ...(revoke ? { revoke: true } : {}) };
    n.onCluster = this.onClusterClause();
    if (revoke && (this.acceptSeq("GRANT", "OPTION", "FOR") || this.acceptSeq("ADMIN", "OPTION", "FOR"))) this.fail("REVOKE ... OPTION FOR is not read");
    if (kw(this.peek(), "CURRENT") && kw(this.peek(1), "GRANTS")) this.fail("GRANT CURRENT GRANTS grants whatever the applying user holds; name the privileges");
    const to = revoke ? "FROM" : "TO";
    for (;;) {
      n.items.push(this.expr(["ON", to]));
      if (this.acceptPunct(",")) continue;
      break;
    }
    if (this.accept("ON")) n.target = this.qualified();
    this.expect(to);
    for (;;) {
      n.grantees.push(this.expr(["WITH"]));
      if (this.acceptPunct(",")) continue;
      break;
    }
    if (this.accept("WITH")) {
      if (this.acceptSeq("GRANT", "OPTION")) n.withOption = "GRANT";
      else if (this.acceptSeq("ADMIN", "OPTION")) n.withOption = "ADMIN";
      else if (kw(this.peek(), "REPLACE")) this.fail("WITH REPLACE OPTION revokes whatever else the grantee holds; declare the complete list instead");
      else this.fail("expected GRANT OPTION or ADMIN OPTION");
    }
    if (!n.target && n.withOption === "GRANT") this.fail("WITH GRANT OPTION is for privileges; a role takes WITH ADMIN OPTION");
    this.acceptPunct(";");
    if (this.peek() !== undefined) this.fail("unexpected token after the grant");
    return n;
  }
}

/** The authentication methods that hold no secret: a user declared with one is created by chant. */
export const SECRETLESS = new Set(["no_password", "ssl_certificate", "ldap", "kerberos", "http", "ssh_key"]);

function refusePassword(p: { fail(message: string, t?: Token): never }, tokens: Token[], node: AccessNode): void {
  const span = node.clauses.identified;
  if (!span) return;
  const sig = tokens.slice(span.from, span.to).filter((t) => !isTrivia(t));
  const words = sig.map((t) => t.text.toLowerCase());
  const method = words[0] === "with" ? words[1] : undefined;
  // `SHOW CREATE USER` prints a password's method without the password (`IDENTIFIED WITH sha256_password`): that much is read.
  const secret = words.includes("by") || words.includes("hash");
  if (secret && method !== "ssh_key") {
    p.fail(
      method === undefined
        ? "IDENTIFIED BY holds a password, which is the environment's: declare the user without IDENTIFIED, create it with its password, and chant manages the rest"
        : `IDENTIFIED WITH ${method} holds a password or its hash, which is the environment's: declare the user without IDENTIFIED, create it with its password, and chant manages the rest`,
      sig[0],
    );
  }
}

/** Parse one access statement. Throws `SqlSyntaxError` located in the statement. */
export function parseAccess(tokens: Token[]): AccessNode {
  return new AccessParser(tokens).parse();
}

/** Whether a statement's text is an access statement this module reads. */
export function isAccessStatement(ddl: string): boolean {
  const words = ddl
    .replace(/--[^\n]*\n/g, " ")
    .trim()
    .split(/\s+/, 4)
    .map((w) => w.toUpperCase());
  if (words[0] === "GRANT" || words[0] === "REVOKE") return true;
  if (words[0] !== "CREATE") return false;
  return words[1] === "USER" || words[1] === "ROLE" || words[1] === "ROW" || words[1] === "POLICY";
}

// ── canonical forms ───────────────────────────────────────────────────

const text = (tokens: Token[], span: Span | undefined): string | undefined =>
  span && span.to > span.from
    ? tokens
        .slice(span.from, span.to)
        .map((t) => t.text)
        .join("")
        .trim()
    : undefined;

const sigOf = (tokens: Token[], span: Span): Token[] => tokens.slice(span.from, span.to).filter((t) => !isTrivia(t));

/** Tokens joined by single spaces: identifiers unquoted, bare words as `word` says. */
function join(sig: Token[], word: (t: string) => string): string {
  return sig.map((t) => (t.kind === "qident" ? unquote(t.text) : t.kind === "ident" ? word(t.text) : t.text)).join(" ");
}

/** A comma-separated list of names, sorted, with the words of `keywords` upper case: `DEFAULT ROLE b, a` and `TO ALL EXCEPT r`. */
function nameList(tokens: Token[], span: Span, keywords: string[]): string {
  const sig = sigOf(tokens, span);
  const out: string[] = [];
  let cur: Token[] = [];
  const flush = () => {
    if (cur.length) out.push(join(cur, (w) => (keywords.includes(w.toUpperCase()) ? w.toUpperCase() : w)));
    cur = [];
  };
  for (const t of sig) {
    if (t.kind === "punct" && t.text === ",") flush();
    else if (t.kind === "ident" && keywords.includes(t.text.toUpperCase()) && cur.length > 0 && !keywords.includes(cur[cur.length - 1]!.text.toUpperCase())) {
      // `ALL EXCEPT a`: the keyword starts a new part.
      flush();
      cur.push(t);
    } else cur.push(t);
  }
  flush();
  const keys = out.filter((x) => keywords.includes(x.split(" ")[0]!));
  const names = out.filter((x) => !keywords.includes(x.split(" ")[0]!)).sort();
  return [...keys, ...names].join(" , ");
}

/** `SETTINGS a = 1 READONLY, b MIN 0 MAX 2`: each setting, sorted by name, `READONLY` as the server prints it (`CONST`). */
function settingsList(tokens: Token[], span: Span): string {
  const sig = sigOf(tokens, span);
  const parts: Token[][] = [[]];
  let depth = 0;
  for (const t of sig) {
    if (t.text === "(") depth++;
    if (t.text === ")") depth--;
    if (depth === 0 && t.kind === "punct" && t.text === ",") parts.push([]);
    else parts[parts.length - 1]!.push(t);
  }
  const words = new Set(["MIN", "MAX", "CONST", "READONLY", "WRITABLE", "CHANGEABLE_IN_READONLY", "PROFILE", "NONE"]);
  return parts
    .filter((p) => p.length > 0)
    .map((p) => join(p, (w) => (words.has(w.toUpperCase()) ? w.toUpperCase() : w)).replace(/\bREADONLY$/, "CONST"))
    .sort()
    .join(" , ");
}

/** `HOST LOCAL, IP '10.0.0.0/8'`: each host, sorted, the kind of each upper case. */
function hostList(tokens: Token[], span: Span): string {
  const words = new Set(["LOCAL", "ANY", "NONE", "IP", "NAME", "REGEXP", "LIKE"]);
  const sig = sigOf(tokens, span);
  const parts: string[] = [];
  let cur: Token[] = [];
  for (const t of [...sig, undefined]) {
    if (!t || (t.kind === "punct" && t.text === ",")) {
      if (cur.length) parts.push(join(cur, (w) => (words.has(w.toUpperCase()) ? w.toUpperCase() : w)));
      cur = [];
    } else cur.push(t);
  }
  return parts.sort().join(" , ");
}

/** `[db.]name` with a table's database filled in. */
function qualifiedName(tokens: Token[], span: Span, defaultDatabase: string): { database: string; name: string } {
  const parts = sigOf(tokens, span)
    .filter((t) => !(t.kind === "punct" && t.text === "."))
    .map((t) => unquote(t.text));
  return parts.length >= 2 ? { database: parts[parts.length - 2]!, name: parts[parts.length - 1]! } : { database: defaultDatabase, name: parts[0] ?? "" };
}

/** What a plan compares of a user, role or row policy: one string per field, absent at its default. */
export interface AccessCanonical {
  kind: "user" | "role" | "rowPolicy";
  name: string;
  /** A row policy's table's database. */
  database?: string;
  /** A row policy's table. */
  table?: string;
  fields: Record<string, string>;
}

/**
 * A user, role or row policy as a plan compares it. A field at the server's
 * default is left out, so a declaration that leaves out `HOST ANY` and the
 * server that does not print it agree. A user's `IDENTIFIED` is kept only
 * when written; a plan compares it only when the declaration has one.
 */
export function accessCanonical(ddl: string, defaultDatabase = "default"): AccessCanonical {
  const tokens = tokenizeText(ddl, 0);
  const node = parseAccess(tokens);
  if (node.statement === "grant") throw new Error("a grant is compared as its grantee's grants (grantsCanonical)");
  const name = unquote(text(tokens, node.name) ?? "");
  const fields: Record<string, string> = {};
  const put = (key: string, value: string | undefined, def?: string) => {
    if (value !== undefined && value !== "" && value !== def) fields[key] = value;
  };
  const c = node.clauses;
  if (node.statement === "user") {
    if (c.notIdentified) fields.identified = "no_password";
    else if (c.identified) {
      // `WITH method` lower case, as the server prints it; key words upper case; strings as written.
      const sig = sigOf(tokens, c.identified);
      const out = sig.map((t, i) => (t.kind === "ident" ? (i === 1 && sig[0]!.text.toUpperCase() === "WITH" ? t.text.toLowerCase() : t.text.toUpperCase()) : t.text));
      fields.identified = out.join(" ").replace(/^WITH no_password$/, "no_password").replace(/^WITH /, "");
    }
    put("host", c.host && hostList(tokens, c.host), "ANY");
    put("validUntil", text(tokens, c.validUntil));
    put("defaultRole", c.defaultRole && nameList(tokens, c.defaultRole, ["ALL", "NONE", "EXCEPT"]), "ALL");
    put("defaultDatabase", c.defaultDatabase && unquote(text(tokens, c.defaultDatabase) ?? ""), "NONE");
    put("grantees", c.grantees && nameList(tokens, c.grantees, ["ANY", "NONE", "EXCEPT"]), "ANY");
    put("settings", c.settings && settingsList(tokens, c.settings), "NONE");
    return { kind: "user", name, fields };
  }
  if (node.statement === "role") {
    put("settings", c.settings && settingsList(tokens, c.settings), "NONE");
    return { kind: "role", name, fields };
  }
  const table = qualifiedName(tokens, node.table!, defaultDatabase);
  put("as", c.as && text(tokens, c.as)!.toUpperCase(), "PERMISSIVE");
  put("for", c.for && join(sigOf(tokens, c.for), (w) => w.toUpperCase()), "SELECT");
  put("using", text(tokens, c.using));
  put("to", c.to && nameList(tokens, c.to, ["ALL", "NONE", "EXCEPT"]), "NONE");
  return { kind: "rowPolicy", name, database: table.database, table: table.name, fields };
}

// ── grants ────────────────────────────────────────────────────────────

/** One grant, the smallest thing a plan adds or takes away. */
export interface GrantAtom {
  /** A privilege, upper case (`SELECT`, `SHOW TABLES`), or the role granted. */
  privilege?: string;
  role?: string;
  /** One column of a column-level privilege. */
  column?: string;
  /** `db.table`, `db.*`, `*.*` or `*`, unquoted. */
  target?: string;
  /** `WITH GRANT OPTION` (a privilege) or `WITH ADMIN OPTION` (a role). */
  option?: boolean;
  /** A partial revoke the server holds (`REVOKE SELECT(b) ON db.t`). Never declared. */
  revoke?: boolean;
}

/** An atom's key, which is also how a plan prints it: `SELECT(a) ON shop.t`, `ROLE reader WITH ADMIN OPTION`. */
export function atomKey(a: GrantAtom): string {
  if (a.role !== undefined) return `ROLE ${a.role}${a.option ? " WITH ADMIN OPTION" : ""}`;
  return `${a.revoke ? "REVOKE " : ""}${a.privilege}${a.column !== undefined ? `(${a.column})` : ""} ON ${a.target}${a.option ? " WITH GRANT OPTION" : ""}`;
}

function grantAtoms(ddl: string, defaultDatabase: string): Array<{ grantees: string[]; atoms: GrantAtom[] }> {
  const out: Array<{ grantees: string[]; atoms: GrantAtom[] }> = [];
  for (const statement of splitLines(ddl)) {
    const tokens = tokenizeText(statement, 0);
    const node = parseAccess(tokens);
    if (node.statement !== "grant") throw new Error(`not a grant: ${statement}`);
    const grantees = node.grantees.map((g) => unquote(text(tokens, g) ?? ""));
    const atoms: GrantAtom[] = [];
    let target: string | undefined;
    if (node.target) {
      const parts = sigOf(tokens, node.target)
        .filter((t) => !(t.kind === "punct" && t.text === "."))
        .map((t) => unquote(t.text));
      target = parts.length >= 2 ? `${parts[0]}.${parts[1]}` : parts[0] === "*" ? "*" : `${defaultDatabase}.${parts[0]}`;
    }
    for (const item of node.items) {
      const sig = sigOf(tokens, item);
      if (!target) {
        atoms.push({ role: unquote(text(tokens, item) ?? ""), ...(node.withOption === "ADMIN" ? { option: true } : {}) });
        continue;
      }
      const open = sig.findIndex((t) => t.text === "(");
      const words = (open < 0 ? sig : sig.slice(0, open)).map((t) => t.text.toUpperCase()).join(" ");
      const columns =
        open < 0
          ? [undefined]
          : sig
              .slice(open + 1, -1)
              .filter((t) => !(t.kind === "punct" && t.text === ","))
              .map((t) => unquote(t.text));
      for (const column of columns) {
        atoms.push({ privilege: words, ...(column !== undefined ? { column } : {}), target, ...(node.withOption === "GRANT" ? { option: true } : {}), ...(node.revoke ? { revoke: true } : {}) });
      }
    }
    out.push({ grantees, atoms });
  }
  return out;
}

/** Statements on their own lines, or separated by `;`, as `SHOW GRANTS` prints them and a group of declarations is joined. */
function splitLines(ddl: string): string[] {
  return ddl
    .split(/;\s*\n|\n(?=\s*(?:GRANT|REVOKE)\b)/i)
    .map((s) => s.trim().replace(/;$/, ""))
    .filter((s) => s.length > 0 && !/^--/.test(s));
}

/** Whether `outer` covers `inner`'s target: the same table, its database's `*`, or `*.*`. */
function covers(outer: string, inner: string): boolean {
  if (outer === inner) return true;
  if (outer === "*.*") return true;
  const [db] = inner.split(".");
  return outer === `${db}.*` && inner !== outer;
}

/**
 * The atoms a grantee holds, with each atom another covers left out, as the
 * server folds them: a column's privilege under the table's, a table's under
 * its database's, any under `*.*`, the same privilege, with a grant option at
 * least as wide.
 */
export function foldAtoms(atoms: readonly GrantAtom[]): GrantAtom[] {
  const keyed = new Map(atoms.map((a) => [atomKey(a), a]));
  const all = [...keyed.values()];
  return all.filter(
    (a) =>
      a.role !== undefined ||
      a.revoke ||
      !all.some(
        (b) =>
          b !== a &&
          !b.revoke &&
          b.role === undefined &&
          b.privilege === a.privilege &&
          b.column === undefined &&
          (b.option ?? false) >= (a.option ?? false) &&
          covers(b.target!, a.target!) &&
          (a.column !== undefined || b.target !== a.target),
      ),
  );
}

/** A grantee's grants as a plan compares them: each atom's key, mapped to the atom. */
export function grantsCanonical(ddl: string, grantee: string, defaultDatabase = "default"): Record<string, string> {
  const atoms = grantAtoms(ddl, defaultDatabase)
    .filter((g) => g.grantees.includes(grantee))
    .flatMap((g) => g.atoms);
  return Object.fromEntries(
    foldAtoms(atoms)
      .map((a) => [atomKey(a), JSON.stringify(a)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/** Every grantee a grant statement names. */
export function granteesOf(ddl: string): string[] {
  return [...new Set(grantAtoms(ddl, "default").flatMap((g) => g.grantees))];
}

// ── statements ────────────────────────────────────────────────────────

const ident = (name: string): string => `\`${name.replace(/`/g, "``")}\``;
const targetSql = (target: string): string =>
  target === "*" || target === "*.*"
    ? target
    : target
        .split(".")
        .map((p) => (p === "*" ? p : ident(p)))
        .join(".");

/** The statement that gives `grantee` one atom. */
export function grantStatement(atom: GrantAtom, grantee: string): string {
  if (atom.role !== undefined) return `GRANT ${ident(atom.role)} TO ${ident(grantee)}${atom.option ? " WITH ADMIN OPTION" : ""}`;
  const priv = `${atom.privilege}${atom.column !== undefined ? `(${ident(atom.column)})` : ""}`;
  // Undoing a partial revoke grants the privilege back.
  return `GRANT ${priv} ON ${targetSql(atom.target!)} TO ${ident(grantee)}${atom.option && !atom.revoke ? " WITH GRANT OPTION" : ""}`;
}

/** The statement that takes one atom from `grantee`. */
export function revokeStatement(atom: GrantAtom, grantee: string): string {
  if (atom.role !== undefined) return `REVOKE ${ident(atom.role)} FROM ${ident(grantee)}`;
  const priv = `${atom.privilege}${atom.column !== undefined ? `(${ident(atom.column)})` : ""}`;
  return `REVOKE ${priv} ON ${targetSql(atom.target!)} FROM ${ident(grantee)}`;
}

/**
 * The `ALTER` that sets one field of a user or role to its declared value,
 * or back to the server's default when the declaration leaves it out.
 */
export function alterAccessField(kind: "user" | "role", name: string, field: string, declared: AccessCanonical["fields"], declaredText: Partial<Record<string, string>>): string {
  const head = `ALTER ${kind === "user" ? "USER" : "ROLE"} ${ident(name)}`;
  const value = declaredText[field];
  switch (field) {
    case "identified":
      return value === undefined || value === "NOT IDENTIFIED" ? `${head} NOT IDENTIFIED` : `${head} IDENTIFIED ${value}`;
    case "host":
      return `${head} HOST ${value ?? "ANY"}`;
    case "validUntil":
      return `${head} VALID UNTIL ${value ?? "'infinity'"}`;
    case "defaultRole":
      return `${head} DEFAULT ROLE ${value ?? "ALL"}`;
    case "defaultDatabase":
      return `${head} DEFAULT DATABASE ${value ?? "NONE"}`;
    case "grantees":
      return `${head} GRANTEES ${value ?? "ANY"}`;
    case "settings":
      return `${head} SETTINGS ${value ?? "NONE"}`;
    default:
      throw new Error(`no ALTER for ${kind} field ${field}`);
  }
}

/** A user's or role's clauses as written, by field, for the `ALTER` that sets one. */
export function accessClauseText(ddl: string): Partial<Record<string, string>> {
  const tokens = tokenizeText(ddl, 0);
  const node = parseAccess(tokens);
  const out: Partial<Record<string, string>> = {};
  for (const [key, span] of Object.entries(node.clauses)) {
    if (!span) continue;
    out[key === "notIdentified" ? "identified" : key] = key === "notIdentified" ? "NOT IDENTIFIED" : text(tokens, span);
  }
  return out;
}

/**
 * The grant declarations of a build, one entry per grantee they name: the
 * export names that grant to it, their statements on their own lines, and
 * what they depend on. A plan compares each entry with what the server
 * holds for that grantee.
 */
export function grantsByGrantee(objects: ReadonlyArray<{ export: string; type: string; ddl: string; dependsOn?: readonly string[] }>): Array<{
  grantee: string;
  exports: string[];
  ddl: string;
  dependsOn: string[];
}> {
  const by = new Map<string, { exports: string[]; statements: string[]; dependsOn: Set<string> }>();
  for (const o of objects) {
    if (o.type !== "ClickHouse::Grant") continue;
    for (const grantee of granteesOf(o.ddl)) {
      const entry = by.get(grantee) ?? { exports: [], statements: [], dependsOn: new Set<string>() };
      entry.exports.push(o.export);
      entry.statements.push(o.ddl.trim().replace(/;$/, ""));
      for (const d of o.dependsOn ?? []) entry.dependsOn.add(d);
      by.set(grantee, entry);
    }
  }
  return [...by].map(([grantee, e]) => ({ grantee, exports: e.exports, ddl: e.statements.join(";\n"), dependsOn: [...e.dependsOn] }));
}
