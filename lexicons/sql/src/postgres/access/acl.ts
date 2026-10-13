/**
 * Access as chant compares it (#3681): the privileges each role holds on each
 * object, and the default privileges objects are created with.
 *
 * A `grant` declaration is a statement, not an object: `GRANT SELECT ON a, b
 * TO r1, r2` is four privileges, and the catalog keeps no statement, only
 * each object's access control list. So declarations and the server are both
 * brought to the same form, one entry per object (or column) and grantee
 * holding a set of privileges, and those entries are compared.
 *
 * What a declared object's entries should be:
 *
 * - what Postgres gives a new object of its kind, the owner's own privileges
 *   left out (a function or procedure: EXECUTE to PUBLIC; anything else:
 *   nothing);
 * - with the declared default privileges for objects of that kind created by
 *   the role that applies, globally and in the object's schema, since chant
 *   creates it as that role;
 * - with every declared GRANT added and every declared REVOKE taken away, in
 *   the build's order.
 *
 * The owner's own privileges are never compared: the owner has them by
 * owning the object. A grant on an object the build does not declare (the
 * `public` schema) is compared too, from what Postgres gives a new object.
 *
 * Default privileges are compared for the role that applies (and each role a
 * declaration names with `FOR ROLE`): globally, where none declared means
 * Postgres's own defaults, and per schema, where none declared means none.
 */

import { quoteIdent } from "../keywords";
import { PG_CLASSIFIER_RULES } from "../plan/rules";
import { classifiedChange } from "../../core/classifier";
import type { PgChange } from "../plan/diff";
import type { CanonicalPgObject } from "../plan/normalize";

export type AclKind = "schema" | "table" | "sequence" | "function" | "procedure" | "column" | "default";

/** The kinds of object default privileges are for. */
export type DefaultObjects = "tables" | "sequences" | "functions" | "types" | "schemas";

/** What an entry is on. */
export interface AclTarget {
  kind: AclKind;
  /** The object's canonical name: `app`, `app.orders`, `app.f(integer)`. Empty for default privileges. */
  name: string;
  column?: string;
  /** Default privileges: whose new objects (`""` for the role that applies), in which schema (undefined: every schema), of which kind. */
  role?: string;
  schema?: string;
  objects?: DefaultObjects;
}

/** One grantee's privileges on one target: each privilege, and whether it was granted WITH GRANT OPTION. */
export interface AclEntry {
  target: AclTarget;
  grantee: string;
  privileges: Map<string, boolean>;
}

export type AccessState = Map<string, AclEntry>;

/** An access change, with the statements that make it and the grant declarations behind it. */
export interface AccessChange {
  change: PgChange;
  target: AclTarget;
  grantee: string;
  sql: string[];
  /** The export names of the declarations that grant or revoke on this target to this grantee. */
  exports: string[];
}

const SELF = "";

/** A target's key: relations (tables, views, sequences) share one namespace, as in the catalog. */
export function targetKey(t: AclTarget): string {
  switch (t.kind) {
    case "schema":
      return `schema ${t.name}`;
    case "table":
    case "sequence":
      return `relation ${t.name}`;
    case "column":
      return `relation ${t.name} (${quoteIdent(t.column ?? "")})`;
    case "function":
    case "procedure":
      return `routine ${t.name}`;
    case "default":
      return `default privileges${t.role ? ` for ${quoteIdent(t.role)}` : ""}${t.schema !== undefined ? ` in ${quoteIdent(t.schema)}` : ""} on ${t.objects}`;
  }
}

export const entryKey = (t: AclTarget, grantee: string): string => `${targetKey(t)} TO ${grantee === "public" ? "PUBLIC" : quoteIdent(grantee)}`;

/** Every privilege of a kind of object, as ALL PRIVILEGES grants them. MAINTAIN is a table's from 17. */
export function allPrivileges(kind: AclKind | DefaultObjects, major: number): string[] {
  switch (kind) {
    case "table":
    case "tables":
      return ["select", "insert", "update", "delete", "truncate", "references", "trigger", ...(major >= 17 ? ["maintain"] : [])];
    case "sequence":
    case "sequences":
      return ["usage", "select", "update"];
    case "schema":
    case "schemas":
      return ["usage", "create"];
    case "function":
    case "procedure":
    case "functions":
      return ["execute"];
    case "types":
      return ["usage"];
    case "column":
      return ["select", "insert", "update", "references"];
    case "default":
      return [];
  }
}

/** What Postgres gives a new object of a kind, the owner's own privileges left out: EXECUTE on a routine and USAGE on a type to PUBLIC. */
export function builtinEntries(kind: AclKind | DefaultObjects): Array<{ grantee: string; privilege: string }> {
  if (kind === "function" || kind === "procedure" || kind === "functions") return [{ grantee: "public", privilege: "execute" }];
  if (kind === "types") return [{ grantee: "public", privilege: "usage" }];
  return [];
}

/** The default-privileges kind an object kind is created as. */
const defaultObjectsOf = (kind: AclKind): DefaultObjects | undefined =>
  kind === "table" ? "tables" : kind === "sequence" ? "sequences" : kind === "function" || kind === "procedure" ? "functions" : kind === "schema" ? "schemas" : undefined;

function add(state: AccessState, target: AclTarget, grantee: string, privilege: string, grantable: boolean): void {
  const key = entryKey(target, grantee);
  let e = state.get(key);
  if (!e) state.set(key, (e = { target, grantee, privileges: new Map() }));
  e.privileges.set(privilege, grantable || e.privileges.get(privilege) === true);
}

function remove(state: AccessState, target: AclTarget, grantee: string, privilege: string, grantOptionOnly: boolean): void {
  const e = state.get(entryKey(target, grantee));
  if (!e || !e.privileges.has(privilege)) return;
  if (grantOptionOnly) e.privileges.set(privilege, false);
  else e.privileges.delete(privilege);
}

/** The state with every empty entry left out. */
const compact = (state: AccessState): AccessState => new Map([...state].filter(([, e]) => e.privileges.size > 0));

interface GrantFields {
  action: "grant" | "revoke";
  on: string;
  objects?: string[];
  privileges: Array<{ privilege: string; columns?: string[] }>;
  grantees: string[];
  forRoles?: string[];
  inSchemas?: string[];
  withGrantOption?: boolean;
  grantOptionFor?: boolean;
}

export interface DeclaredAccess {
  state: AccessState;
  /** Every target the declarations decide: the declared objects and what the grants name. */
  targets: AclTarget[];
  /** The export names of the declarations behind each entry. */
  exportsOf: Map<string, string[]>;
  /** The roles `FOR ROLE` names, whose default privileges are compared too. */
  forRoles: string[];
}

/**
 * The access a set of declarations adds up to. `objects` are canonical, in
 * the build's order, keyed by export name. `self` is the role that applies,
 * when known: a declaration naming it with `FOR ROLE` is its own default
 * privileges, and a grant to it is the owner's, which is never compared.
 */
export function declaredAccess(objects: ReadonlyArray<{ key: string; canonical: CanonicalPgObject }>, opts: { major: number; self?: string }): DeclaredAccess {
  const state: AccessState = new Map();
  const exportsOf = new Map<string, string[]>();
  const targets = new Map<string, AclTarget>();
  const relationKind = new Map<string, "table" | "sequence">();
  const routineKind = new Map<string, "function" | "procedure">();
  const forRoles = new Set<string>();
  const roleOf = (r: string | undefined) => (r === undefined || r === opts.self ? SELF : r);
  const note = (key: string, exportName: string) => exportsOf.set(key, [...new Set([...(exportsOf.get(key) ?? []), exportName])]);

  // The objects themselves.
  const declaredTargets: AclTarget[] = [];
  for (const { canonical: o } of objects) {
    const name = `${o.schema ? `${quoteIdent(o.schema)}.` : ""}${quoteIdent(o.name)}`;
    if (o.kind === "schema") declaredTargets.push({ kind: "schema", name: quoteIdent(o.name) });
    else if (o.kind === "table" || o.kind === "view" || o.kind === "materializedView") {
      relationKind.set(name, "table");
      declaredTargets.push({ kind: "table", name });
    } else if (o.kind === "sequence") {
      relationKind.set(name, "sequence");
      declaredTargets.push({ kind: "sequence", name });
    } else if (o.kind === "function" || o.kind === "procedure") {
      routineKind.set(`${name}${o.signature ?? ""}`, o.kind);
      declaredTargets.push({ kind: o.kind, name: `${name}${o.signature ?? ""}` });
    }
  }

  // Default privileges, per role, schema and kind of object.
  const defaults: AccessState = new Map();
  const declaredDefaults = new Set<string>();
  for (const { key: exportName, canonical: o } of objects) {
    if (o.kind !== "defaultPrivileges") continue;
    const g = o.fields.grant as GrantFields;
    const on = g.on as DefaultObjects;
    for (const r of g.forRoles ?? [undefined]) {
      const role = roleOf(r);
      if (role !== SELF) forRoles.add(role);
      for (const schema of g.inSchemas ?? [undefined]) {
        const target: AclTarget = { kind: "default", name: "", role, ...(schema !== undefined ? { schema } : {}), objects: on };
        const tk = targetKey(target);
        if (!declaredDefaults.has(tk)) {
          declaredDefaults.add(tk);
          targets.set(tk, target);
          // A global entry starts from Postgres's own defaults; a schema's from nothing.
          if (schema === undefined) for (const b of builtinEntries(on)) add(defaults, target, b.grantee, b.privilege, false);
        }
        for (const grantee of g.grantees) {
          for (const p of g.privileges) {
            for (const privilege of p.privilege === "all" ? allPrivileges(on, opts.major) : [p.privilege]) {
              if (g.action === "grant") add(defaults, target, grantee, privilege, g.withGrantOption === true);
              else remove(defaults, target, grantee, privilege, g.grantOptionFor === true);
            }
          }
          note(entryKey(target, grantee), exportName);
        }
      }
    }
  }
  for (const [k, e] of defaults) state.set(k, e);

  /** What an object chant creates is given: Postgres's defaults, or the declared global ones, and the declared ones for its schema. */
  const created = (t: AclTarget, schema: string | undefined) => {
    const objectsKind = defaultObjectsOf(t.kind);
    const global = objectsKind ? [...defaults.values()].filter((e) => e.target.role === SELF && e.target.schema === undefined && e.target.objects === objectsKind) : [];
    const anyGlobal = objectsKind !== undefined && declaredDefaults.has(targetKey({ kind: "default", name: "", role: SELF, objects: objectsKind }));
    if (!anyGlobal) for (const b of builtinEntries(t.kind)) add(state, t, b.grantee, b.privilege, false);
    for (const e of global) for (const [p, g] of e.privileges) add(state, t, e.grantee, p, g);
    if (objectsKind && schema !== undefined && objectsKind !== "schemas") {
      for (const e of defaults.values()) {
        if (e.target.role === SELF && e.target.schema === schema && e.target.objects === objectsKind) for (const [p, g] of e.privileges) add(state, t, e.grantee, p, g);
      }
    }
  };
  for (const t of declaredTargets) {
    targets.set(targetKey(t), t);
    const schema = t.kind === "schema" ? undefined : unquotedSchema(t.name);
    created(t, schema);
  }

  // Grants and revokes, in the build's order.
  for (const { key: exportName, canonical: o } of objects) {
    if (o.kind !== "grant") continue;
    const g = o.fields.grant as GrantFields;
    for (const name of g.objects ?? []) {
      const kind: AclKind =
        g.on === "schema"
          ? "schema"
          : g.on === "sequence"
            ? "sequence"
            : g.on === "table"
              ? (relationKind.get(name) ?? "table")
              : g.on === "procedure"
                ? "procedure"
                : g.on === "function"
                  ? "function"
                  : (routineKind.get(name) ?? "function");
      const target: AclTarget = { kind, name };
      const tk = targetKey(target);
      if (!targets.has(tk)) {
        // An object the build does not declare starts from what Postgres gives a new one.
        targets.set(tk, target);
        for (const b of builtinEntries(kind)) add(state, target, b.grantee, b.privilege, false);
      }
      for (const grantee of g.grantees) {
        for (const p of g.privileges) {
          const on: AclTarget[] = p.columns ? p.columns.map((column) => ({ kind: "column" as const, name, column })) : [target];
          for (const t of on) {
            if (t.kind === "column") targets.set(targetKey(t), t);
            for (const privilege of p.privilege === "all" ? allPrivileges(t.kind, opts.major) : [p.privilege]) {
              if (g.action === "grant") add(state, t, grantee, privilege, g.withGrantOption === true);
              else remove(state, t, grantee, privilege, g.grantOptionFor === true);
            }
            note(entryKey(t, grantee), exportName);
          }
        }
      }
    }
  }

  // A grant to the role that applies is the owner's, which owning gives.
  const out = compact(new Map([...state].filter(([, e]) => opts.self === undefined || e.grantee !== opts.self)));
  return { state: out, targets: [...targets.values()], exportsOf, forRoles: [...forRoles].sort() };
}

/** The schema of a canonical qualified name, unquoted. */
function unquotedSchema(name: string): string | undefined {
  const m = /^("(?:[^"]|"")*"|[^."]+)\./.exec(name);
  if (!m) return undefined;
  return m[1]!.startsWith('"') ? m[1]!.slice(1, -1).replace(/""/g, '"') : m[1]!;
}

const show = (privileges: ReadonlyMap<string, boolean> | undefined): string | undefined =>
  privileges && privileges.size > 0 ? [...privileges].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, g]) => `${p}${g ? "*" : ""}`).join(", ") : undefined;

const ON: Record<Exclude<AclKind, "default" | "column">, string> = { schema: "SCHEMA", table: "TABLE", sequence: "SEQUENCE", function: "FUNCTION", procedure: "PROCEDURE" };

/** The `ON ...` and grantee of an entry's statements. */
function onClause(t: AclTarget): string {
  if (t.kind === "column" || t.kind === "default") return "";
  return `ON ${ON[t.kind]} ${t.name}`;
}

const granteeSql = (g: string) => (g === "public" ? "PUBLIC" : quoteIdent(g));

/** One GRANT or REVOKE for a set of privileges on one entry's target. */
function statement(t: AclTarget, grantee: string, action: "grant" | "revoke" | "revoke-option", privileges: string[], withGrantOption = false): string {
  const list = privileges.map((p) => p.toUpperCase()).join(", ");
  const verb = action === "grant" ? "GRANT" : action === "revoke" ? "REVOKE" : "REVOKE GRANT OPTION FOR";
  const to = action === "grant" ? "TO" : "FROM";
  const tail = action === "grant" && withGrantOption ? " WITH GRANT OPTION" : "";
  if (t.kind === "column") return `${verb} ${privileges.map((p) => `${p.toUpperCase()} (${quoteIdent(t.column ?? "")})`).join(", ")} ON TABLE ${t.name} ${to} ${granteeSql(grantee)}${tail}`;
  if (t.kind === "default") {
    const head = `ALTER DEFAULT PRIVILEGES${t.role ? ` FOR ROLE ${quoteIdent(t.role)}` : ""}${t.schema !== undefined ? ` IN SCHEMA ${quoteIdent(t.schema)}` : ""}`;
    return `${head} ${verb} ${list} ON ${String(t.objects).toUpperCase()} ${to} ${granteeSql(grantee)}${tail}`;
  }
  return `${verb} ${list} ${onClause(t)} ${to} ${granteeSql(grantee)}${tail}`;
}

/**
 * The changes from `before` to `after`, one per entry and direction, each
 * with its statements: revokes first (a privilege, then a grant option), then
 * grants (a grant option on its own with WITH GRANT OPTION).
 */
export function diffAccess(before: AccessState, after: AccessState, exportsOf: ReadonlyMap<string, string[]> = new Map()): AccessChange[] {
  const out: AccessChange[] = [];
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  for (const key of keys) {
    const b = before.get(key);
    const a = after.get(key);
    const target = (a ?? b)!.target;
    const grantee = (a ?? b)!.grantee;
    const bp = b?.privileges ?? new Map<string, boolean>();
    const ap = a?.privileges ?? new Map<string, boolean>();
    const revoke = [...bp.keys()].filter((p) => !ap.has(p)).sort();
    const revokeOption = [...bp].filter(([p, g]) => g && ap.get(p) === false).map(([p]) => p).sort();
    const grant = [...ap].filter(([p, g]) => !bp.has(p) || (g && bp.get(p) === false)).map(([p]) => p).sort();
    if (revoke.length + revokeOption.length + grant.length === 0) continue;
    const exports = exportsOf.get(key) ?? [];
    const rule = target.kind === "default" ? "SQLPG298" : revoke.length + revokeOption.length > 0 && grant.length === 0 ? "SQLPG297" : "SQLPG296";
    const sql: string[] = [];
    if (revoke.length > 0) sql.push(statement(target, grantee, "revoke", revoke));
    if (revokeOption.length > 0) sql.push(statement(target, grantee, "revoke-option", revokeOption));
    const plain = grant.filter((p) => ap.get(p) === false);
    const withOption = grant.filter((p) => ap.get(p) === true);
    if (plain.length > 0) sql.push(statement(target, grantee, "grant", plain));
    if (withOption.length > 0) sql.push(statement(target, grantee, "grant", withOption, true));
    const change = classifiedChange(PG_CLASSIFIER_RULES, `acl ${key}`, "privileges", rule, show(bp), show(ap), revoke.length > 0 && grant.length > 0 ? { note: `revokes ${revoke.join(", ")}` } : {});
    out.push({ change, target, grantee, sql, exports });
  }
  return out;
}

/** What a server holds: its entries, which objects exist, and for which kinds the role that applies has global default privileges of its own. */
export interface LiveAccess {
  state: AccessState;
  /** The target keys of the objects that exist. */
  present: Set<string>;
  /** The kinds of object the role that applies has a global `pg_default_acl` row for. */
  globalDefaults: Set<DefaultObjects>;
}

/**
 * The entries the server would give each declared object that does not exist
 * yet: Postgres's defaults, or the role's global default privileges, and its
 * default privileges in the object's schema.
 */
export function predictedAccess(missing: readonly AclTarget[], live: LiveAccess): AccessState {
  const out: AccessState = new Map();
  const defaults = [...live.state.values()].filter((e) => e.target.kind === "default" && e.target.role === SELF);
  for (const t of missing) {
    const objectsKind = defaultObjectsOf(t.kind);
    if (!objectsKind) continue;
    if (!live.globalDefaults.has(objectsKind)) for (const b of builtinEntries(t.kind)) add(out, t, b.grantee, b.privilege, false);
    const schema = t.kind === "schema" ? undefined : unquotedSchema(t.name);
    for (const e of defaults) {
      if (e.target.objects !== objectsKind) continue;
      if (e.target.schema === undefined || (e.target.schema === schema && objectsKind !== "schemas")) for (const [p, g] of e.privileges) add(out, t, e.grantee, p, g);
    }
  }
  return compact(out);
}

/** Adds an entry, for the live reader. */
export const addEntry = add;
export { SELF as APPLYING_ROLE };
