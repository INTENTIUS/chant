import { describe, expect, it } from "vitest";
import { parseCedarSchema, resolveTypeRef, type CedarEntityDecl, type CedarActionDecl } from "./parse";
import { resolveSchema } from "./wasm";

const SCHEMA = `
namespace Chant {
  type Level = Long;
  type Tags = Set<String>;

  entity Group;

  entity User in [Group] = {
    "department": String,
    "level": Level,
    "manager"?: User,
    "tags": Tags,
    "active": Bool,
  };

  entity Env enum ["prod", "dev"];

  action read appliesTo {
    principal: [User],
    resource: [Group],
    context: { "mfa": Bool, "ip"?: ipaddr }
  };
}
`;

function entity(name: string): CedarEntityDecl {
  const decl = parseCedarSchema(SCHEMA).decls.find((d) => d.typeName === name);
  if (!decl || decl.kind !== "entity") throw new Error(`no entity ${name}`);
  return decl;
}

describe("parseCedarSchema", () => {
  it("produces one declaration per entity type and action", () => {
    const names = parseCedarSchema(SCHEMA).decls.map((d) => d.typeName);
    // Entity types first, then actions, each group sorted — the order the
    // resolved JSON already hands back, which is what keeps codegen stable.
    expect(names).toEqual([
      "Chant::Env",
      "Chant::Group",
      "Chant::User",
      'Chant::Action::"read"',
    ]);
  });

  it("resolves common types away", () => {
    const attrs = Object.fromEntries(entity("Chant::User").attributes.map((a) => [a.name, a.type]));
    // `level` is declared as the common type `Level`; nothing downstream should
    // ever see the alias.
    expect(attrs.level).toEqual({ kind: "primitive", cedar: "Long", ts: "number" });
    expect(attrs.tags).toEqual({
      kind: "set",
      element: { kind: "primitive", cedar: "String", ts: "string" },
    });
  });

  it("keeps entity references as references, not strings", () => {
    const manager = entity("Chant::User").attributes.find((a) => a.name === "manager");
    expect(manager?.type).toEqual({ kind: "entity", entityType: "Chant::User" });
  });

  it("treats a missing `required` as required, the opposite of JSON Schema", () => {
    const attrs = entity("Chant::User").attributes;
    expect(attrs.find((a) => a.name === "department")?.required).toBe(true);
    expect(attrs.find((a) => a.name === "manager")?.required).toBe(false);
  });

  it("carries enum entity values through", () => {
    expect(entity("Chant::Env").enumValues).toEqual(["prod", "dev"]);
  });

  it("reads an action's appliesTo and context", () => {
    const decl = parseCedarSchema(SCHEMA).decls.find((d) => d.kind === "action") as CedarActionDecl;
    expect(decl.actionId).toBe("read");
    expect(decl.principalTypes).toEqual(["Chant::User"]);
    expect(decl.resourceTypes).toEqual(["Chant::Group"]);
    expect(decl.context.map((a) => a.name)).toEqual(["ip", "mfa"]);
    expect(decl.context.find((a) => a.name === "ip")?.type).toEqual({ kind: "extension", name: "ipaddr" });
  });

  it("handles the empty namespace", () => {
    const decls = parseCedarSchema(`entity Thing = { "n": Long };`).decls;
    expect(decls.map((d) => d.typeName)).toEqual(["Thing"]);
  });

  it("reports a malformed schema with Cedar's own message", () => {
    expect(() => parseCedarSchema("entity User = {")).toThrow(/schema did not resolve/);
  });

  it("does not treat a parseable empty schema as a schema", () => {
    // `checkParseSchema("")` succeeds — an empty schema is legal Cedar (#1648
    // §1) — so "did it parse" can never stand in for "is there a schema".
    expect(parseCedarSchema("").decls).toEqual([]);
  });
});

describe("resolveTypeRef", () => {
  it("survives a self-referential common type instead of spinning", () => {
    const commonTypes = { Loop: { type: "Chant::Loop" } };
    expect(resolveTypeRef({ type: "Chant::Loop" }, commonTypes, "Chant")).toEqual({
      kind: "opaque",
      name: "Chant::Loop",
    });
  });
});

describe("resolveSchema", () => {
  it("refuses a non-string rather than trapping the wasm", () => {
    // A JS object here is `memory access out of bounds`, not a failure answer
    // (#1648 §5.4) — the guard is what keeps that from reaching the caller.
    const result = resolveSchema({ Chant: {} });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/as a string/);
  });

  it("leaves the wasm usable after a rejected call", () => {
    resolveSchema(123);
    expect(resolveSchema(SCHEMA).ok).toBe(true);
  });
});
