/**
 * The shared core, exercised with a toy dialect so nothing here depends on
 * ClickHouse: whatever a second dialect reuses has to work without it.
 */

import { describe, expect, test } from "vitest";
import type { Declarable } from "@intentius/chant";
import {
  SqlLiteral,
  SqlObject,
  SqlTemplateError,
  applyOrder,
  changedEntries,
  changesByObject,
  classifiedChange,
  classifierRule,
  classifyDisruptionWith,
  interpolationLine,
  isColumnRefOf,
  isSqlObjectOf,
  lineageJson,
  makeSqlEntity,
  matchByIdentity,
  migrationOpName,
  missingDependencies,
  notAttemptedOutcome,
  previouslyIn,
  readBuildObjects,
  receiptAddress,
  renderChangeSet,
  renderMigrationOps,
  resolveOwnershipMarker,
  spliceText,
  splitTopLevel,
  SqlApplyError,
  templateParts,
  toApplyResult,
  type ChangeClasses,
  type Keyed,
} from "./index";

// ── A toy dialect ────────────────────────────────────────────────────────

abstract class ToyObject extends SqlObject {
  declare readonly entityType: "Toy::Table";
}
const toy = (sqlName: string, columns: string[], dependsOn: unknown[] = []) =>
  makeSqlEntity(ToyObject.prototype as ToyObject, "Toy::Table", sqlName, { name: sqlName }, columns, dependsOn) as ToyObject & {
    columns: Record<string, unknown>;
  };

type ToyClass = "safe" | "locks" | "create" | "drop";
const CLASSES: ChangeClasses<ToyClass> = {
  order: ["create", "safe", "locks", "drop"],
  label: { create: "create", safe: "safe", locks: "TAKES A LOCK", drop: "drop" },
  disruption: { create: "in-place", safe: "in-place", locks: "replace", drop: "destroy" },
};
const RULES = {
  TOY200: classifierRule("TOY200", "create" as ToyClass, "Create", "Nothing existing changes.", "https://example.test/create"),
  TOY201: classifierRule("TOY201", "safe" as ToyClass, "Add a column", "Metadata only.", "https://example.test/add"),
  TOY202: classifierRule("TOY202", "locks" as ToyClass, "Change a type", "Rewrites under a lock.", "https://example.test/type"),
  TOY250: classifierRule("TOY250", "drop" as ToyClass, "Drop", "Not undone.", "https://example.test/drop"),
};

describe("entities", () => {
  test("hide everything but dependsOn, and hand out column references", () => {
    const users = toy("users", ["id", "email"]);
    const orders = toy("orders", ["user_id"], [users]);
    expect(Object.keys(orders)).toEqual(["dependsOn"]);
    expect(orders).toBeInstanceOf(ToyObject);
    expect(orders.lexicon).toBe("sql");
    expect(isSqlObjectOf(orders, "Toy::")).toBe(true);
    expect(isSqlObjectOf(orders, "ClickHouse::")).toBe(false);
    expect(isColumnRefOf(users.columns.id, (p) => isSqlObjectOf(p, "Toy::"))).toBe(true);
    expect(isColumnRefOf("id", (p) => isSqlObjectOf(p, "Toy::"))).toBe(false);
  });

  test("order by references, ties by export name, and refuse a cycle", () => {
    const users = toy("users", ["id"]);
    const orders = toy("orders", ["user_id"], [users.columns.id]);
    const names = new Map<Declarable, string>([
      [users, "users"],
      [orders, "orders"],
    ]);
    expect(applyOrder(new Map([["orders", orders], ["users", users]]), names)).toEqual(["users", "orders"]);
    expect(lineageJson([{ output: "id", expr: "id", from: [users.columns.id as never] }], names)).toEqual([{ output: "id", expr: "id", from: ["users.id"] }]);
    const a = { dependsOn: [] as unknown[] };
    const b = { dependsOn: [a] };
    a.dependsOn.push(b);
    expect(() => applyOrder(new Map([["a", a], ["b", b]]), new Map<Declarable, string>([[a as never, "a"], [b as never, "b"]]))).toThrow(/reference cycle.*a -> b -> a/);
  });
});

describe("templates", () => {
  test("splice values, and undo the two forced escapes", () => {
    expect(spliceText("x + 1")).toBe("x + 1");
    expect(spliceText(2n)).toBe("2");
    expect(spliceText(null)).toBe("NULL");
    expect(spliceText(new SqlLiteral("'a'"))).toBe("'a'");
    expect(spliceText(undefined)).toMatchObject({ error: expect.stringMatching(/\.columns/) });
    expect(spliceText({})).toMatchObject({ error: expect.stringMatching(/an object/) });
    expect(templateParts(Object.assign(["a \\` b \\${c}"], { raw: ["a \\` b \\${c}"] }) as unknown as TemplateStringsArray)).toEqual(["a ` b ${c}"]);
    expect(interpolationLine(["a\nb", "c"], 0)).toBe(2);
    expect(new SqlTemplateError("table", "bad", 0, 0).message).toBe("table`...`: bad");
  });
});

describe("identity, diff and the classifier", () => {
  type O = { name: string; schema: string; type: string; previously?: string };
  const keyed = (key: string, o: O): Keyed<O> => ({ key, canonical: o });
  const rules = {
    qualified: (o: O) => `${o.schema}.${o.name}`,
    previously: (o: O) => o.previously,
    previousNames: (o: O, prev: string) => [prev, `${o.schema}.${prev}`],
  };

  test("match by key, then by a rename hint, and list the rest as created and dropped", () => {
    const before = [keyed("public.users", { name: "users", schema: "public", type: "int" }), keyed("public.old", { name: "old", schema: "public", type: "int" })];
    const after = [
      keyed("public.users", { name: "users", schema: "public", type: "bigint" }),
      keyed("public.accounts", { name: "accounts", schema: "public", type: "int", previously: "old" }),
      keyed("public.fresh", { name: "fresh", schema: "public", type: "int" }),
    ];
    expect(matchByIdentity(before, after, rules).map((m) => [m.kind, m.kind === "dropped" ? m.before.key : m.after.key])).toEqual([
      ["matched", "public.users"],
      ["matched", "public.accounts"],
      ["created", "public.fresh"],
    ]);
    expect(matchByIdentity(before, after.slice(0, 1), rules).map((m) => m.kind)).toEqual(["matched", "dropped"]);
    expect(changedEntries({ a: "1", b: "2" }, { b: "3", c: "4" })).toEqual(["a", "b", "c"]);
  });

  test("class each change from its rule, report it, and map it onto classifyDisruption", () => {
    const changes = [
      classifiedChange(RULES, "users", "columns.id.type", "TOY202", "int", "bigint"),
      classifiedChange(RULES, "users", "columns.email", "TOY201", undefined, "email text"),
    ];
    expect(changes[0]).toEqual({ object: "users", field: "columns.id.type", before: "int", after: "bigint", rule: "TOY202", class: "locks" });
    expect(changesByObject(changes).get("users")).toHaveLength(2);
    const text = renderChangeSet({ changes, hints: ["a hint"] }, { title: "base -> head", rules: RULES, classes: CLASSES, trailer: ["", "Refused."] });
    expect(text.split("\n")).toEqual([
      "base -> head",
      "",
      "users",
      "  [TAKES A LOCK] columns.id.type: int -> bigint",
      "      TOY202 Change a type. Rewrites under a lock. https://example.test/type",
      "  [safe] columns.email: email text",
      "      TOY201 Add a column. Metadata only. https://example.test/add",
      "",
      "1 safe, 1 TAKES A LOCK",
      "hint: a hint",
      "",
      "Refused.",
    ]);
    expect(renderChangeSet({ changes: [], hints: [] }, { rules: RULES, classes: CLASSES, trailer: ["never"] })).toBe("No changes.");

    const ruleFor = (path: string) => (path.startsWith("type") ? "TOY202" : path.startsWith("add") ? "TOY201" : path === "?" ? "ambiguous" : undefined) as "TOY201" | "TOY202" | "ambiguous" | undefined;
    const classify = (paths: string[], type = "Toy::Table") =>
      classifyDisruptionWith(
        { typePrefix: "Toy::", rules: RULES, classes: CLASSES, ruleFor, ambiguousDetail: "needs the plan" },
        { environment: "e", changes: [{ name: "t", type, deltas: paths.map((path) => ({ path })) } as never] },
      );
    expect(classify(["add", "type"]).t).toEqual({ disruption: "replace", because: ["type"], detail: "TOY201 Add a column; TOY202 Change a type" });
    expect(classify(["add", "?"]).t).toEqual({ disruption: "unknown", because: ["add", "?"], detail: "needs the plan" });
    expect(classify(["add"], "Other::Thing")).toEqual({});
  });
});

describe("normalization helpers", () => {
  test("read the rename hint, and split on top-level commas", () => {
    expect(previouslyIn(["-- previously: old_name"])).toBe("old_name");
    expect(previouslyIn(['-- previously: "Old"'])).toBe("Old");
    expect(previouslyIn(["-- a comment"])).toBeUndefined();
    expect(splitTopLevel("a , f ( b , c ) , [ d , e ]")).toEqual(["a", "f ( b , c )", "[ d , e ]"]);
  });
});

describe("apply plumbing", () => {
  const doc = (dialect: string, objects: unknown[]) => JSON.stringify({ sql: { dialect, objects } });

  test("reads a build's objects for one dialect, nested or not", () => {
    const objects = readBuildObjects(doc("toy", [{ export: "t", type: "Toy::Table", ddl: "CREATE TABLE t ()", dependsOn: ["s", "s.id", 3] }]), "toy", (o) => o);
    expect(objects).toEqual([{ export: "t", type: "Toy::Table", ddl: "CREATE TABLE t ()", dependsOn: ["s"] }]);
    expect(() => readBuildObjects(doc("other", []), "toy", (o) => o)).toThrow('expected { dialect: "toy", objects: [...] }');
    expect(() => readBuildObjects(doc("toy", [{ export: "t" }]), "toy", (o) => o)).toThrow("objects[0] has no export, type or ddl");
  });

  test("keeps the tri-state, projects it onto the envelope, and names the dialect in its error", () => {
    const outcome = notAttemptedOutcome([{ kind: "Toy::Table", name: "t" }], "no-binding", "nothing bound");
    expect(toApplyResult(outcome).notAttempted).toEqual([{ kind: "Toy::Table", name: "t", reason: "no-binding", detail: "nothing bound" }]);
    const failed = { ...outcome, target: "toy://x", notAttempted: [], failed: [{ kind: "Toy::Table", name: "t", error: "refused", statements: [] }] };
    const err = new SqlApplyError("Toy", failed);
    expect(err.message).toBe("Toy apply to toy://x: 1 object(s) failed (Toy::Table/t: refused); 0 applied, 0 pruned, 0 not attempted before and after");
    expect(err.outcome).toBe(failed);
    expect(missingDependencies("v", ["t", "v", "external"], new Set(["t", "v"]), new Set())).toEqual(["t"]);
  });

  test("resolves the ownership marker from args, then config", () => {
    expect(resolveOwnershipMarker({ stack: "a" }, { ownership: { stack: "b", env: "prod" } }, "toy apply")).toEqual({ stack: "a", env: "prod" });
    expect(resolveOwnershipMarker({}, { ownership: { stack: "b", enabled: false } }, "toy apply")).toBeUndefined();
    expect(() => resolveOwnershipMarker({}, { ownership: { stack: "b", env: { param: "env" } } as never }, "toy apply")).toThrow(/^toy apply: ownership.env/);
  });
});

describe("receipts and the migration hand-off", () => {
  test("address receipts by stack, env and effect", () => {
    expect(receiptAddress({ stack: "shop", env: "prod" }, "migrate/users/1")).toBe("shop/prod/migrate/users/1");
    expect(receiptAddress({}, "e")).toBe("-/-/e");
  });

  test("name and render the Op to run instead", () => {
    expect(migrationOpName("migrate", "public.Users")).toBe("migrate-public-users");
    const op = { table: "public.users", name: "migrate-public-users", env: "prod", declaration: "export const { op } = ToyOp({});" };
    expect(renderMigrationOps([op], { what: "the toy Op", exportName: "ToyOp", importPath: "toy" })).toEqual([
      "",
      'Run it as the toy Op, declared in an *.op.ts file (import { ToyOp } from "toy"), then `chant run <name>` until it is done:',
      "  export const { op } = ToyOp({});",
    ]);
    expect(renderMigrationOps([], { what: "x", exportName: "X", importPath: "x" })).toEqual([]);
  });
});

describe("tokens, cursor and template finding", () => {
  test("a dialect's lexical rules decide quotes and punctuation", async () => {
    const { tokenizeText } = await import("./tokens");
    const rules = { identQuotes: '"', backslashEscapes: false, punct: "(),;.", opChars: /[=<>]/ };
    expect(tokenizeText('"a""b" = \'x\\\'', 0, rules).map((t) => [t.kind, t.text])).toEqual([
      ["qident", '"a""b"'],
      ["ws", " "],
      ["op", "="],
      ["ws", " "],
      ["string", "'x\\'"],
    ]);
  });

  test("a tag is a dialect's by the module it is imported from", async () => {
    const ts = await import("typescript");
    const { findSqlTemplates } = await import("./find-templates");
    const source = ts.createSourceFile(
      "f.ts",
      'import { table } from "toy-a";\nimport { table as t2 } from "toy-b";\nexport const x = table`CREATE TABLE x (a int)`;\nexport const y = t2`CREATE TABLE y (${x}) b`;',
      ts.ScriptTarget.Latest,
      true,
    );
    const found = findSqlTemplates(source, [
      { dialect: "a", modules: ["toy-a"], tags: ["table"] },
      { dialect: "b", modules: ["toy-b"], tags: ["table"] },
    ]);
    expect(found.map((f) => [f.dialect, f.tag, f.parts])).toEqual([
      ["a", "table", ["CREATE TABLE x (a int)"]],
      ["b", "table", ["CREATE TABLE y (", ") b"]],
    ]);
  });
});
