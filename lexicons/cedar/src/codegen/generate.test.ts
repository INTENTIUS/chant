import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "./generate";
import { buildEmitModel, generateRegistry, generateRuntimeIndex, generateTypes } from "./emit";
import { createNaming } from "./naming";
import { parseCedarSchema } from "../spec/parse";
import { requiredNames } from "../validate";

const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function emitFrom(schema: string) {
  const { decls } = parseCedarSchema(schema);
  const model = buildEmitModel(decls, createNaming(decls));
  return {
    model,
    registry: JSON.parse(generateRegistry(model)) as Record<string, { resourceType: string; kind: string }>,
    indexTS: generateRuntimeIndex(model),
    typesDTS: generateTypes(model),
  };
}

describe("cedar generate", () => {
  it("generates from the bundled default schema with no project schema in sight", async () => {
    // The default is the reason this lexicon's generate step is gateable at
    // all: every other lexicon has an upstream to fetch, cedar's input is the
    // user's own file, and a fresh checkout has none (#1650).
    const result = await generate({ projectRoot: join(pkgDir, "does-not-exist") });
    expect(result.resources).toBe(16);
    expect(result.warnings).toEqual([]);
  });

  it("is deterministic", async () => {
    const a = await generate({ projectRoot: pkgDir });
    const b = await generate({ projectRoot: pkgDir });
    expect(b.lexiconJSON).toBe(a.lexiconJSON);
    expect(b.typesDTS).toBe(a.typesDTS);
    expect(b.indexTS).toBe(a.indexTS);
  });

  it("produces every name validate.ts requires", async () => {
    const result = await generate({ projectRoot: pkgDir });
    const keys = new Set(Object.keys(JSON.parse(result.lexiconJSON) as Record<string, unknown>));
    expect(requiredNames.filter((n) => !keys.has(n))).toEqual([]);
  });

  it("keeps the required-name list above the tier-3 bar", () => {
    expect(requiredNames.length).toBeGreaterThanOrEqual(30);
  });

  it("writes the runtime module index.ts imports its factories from", async () => {
    const result = await generate({ projectRoot: pkgDir });
    expect(result.extraArtifacts?.["runtime.ts"]).toContain("createResource");
  });
});

describe("emitters", () => {
  const schema = `
    namespace App {
      type Level = Long;
      entity Group;
      entity User in [Group] = { "level": Level, "nick"?: String, "peers": Set<User> };
      action read appliesTo { principal: [User], resource: [Group], context: { "mfa": Bool } };
    }
  `;

  it("names entity types, actions and their record types apart", () => {
    const { registry } = emitFrom(schema);
    expect(Object.keys(registry).sort()).toEqual([
      "Group",
      "GroupAttributes",
      "Policy",
      "ReadAction",
      "ReadContext",
      "User",
      "UserAttributes",
    ]);
    expect(registry.ReadAction.resourceType).toBe('App::Action::"read"');
    expect(registry.ReadContext.kind).toBe("property");
    expect(registry.User.kind).toBe("resource");
  });

  it("emits optional attributes as optional and sets as arrays", () => {
    const { indexTS } = emitFrom(schema);
    expect(indexTS).toContain("nick?: string;");
    expect(indexTS).toContain("peers: UserUid[];");
    expect(indexTS).toContain("level: number;");
  });

  it("renders an entity reference as the referenced entity's UID type", () => {
    const { indexTS } = emitFrom(schema);
    expect(indexTS).toContain('export type UserUid = `App::User::"${string}"`;');
  });

  it("gives the Policy class the name users import, even against a schema that wants it", () => {
    // `Policy` is a priority name, so a schema declaring its own `Policy`
    // entity type gets qualified rather than taking the authoring class's name.
    const { registry } = emitFrom(`namespace App { entity Policy = { "n": String }; }`);
    expect(registry.Policy.resourceType).toBe("Cedar::Policy");
    expect(registry.AppPolicy.resourceType).toBe("App::Policy");
  });

  it("qualifies an entity type that collides with an action name", () => {
    const { registry } = emitFrom(`
      namespace App {
        entity ReadAction;
        entity Doc;
        action read appliesTo { principal: [ReadAction], resource: [Doc] };
      }
    `);
    const types = Object.values(registry).map((e) => e.resourceType);
    expect(types).toContain("App::ReadAction");
    expect(types).toContain('App::Action::"read"');
    // Both present under distinct keys; nothing silently overwritten.
    expect(new Set(types).size).toBe(types.length);
  });

  it("emits a schema with no declarations without producing invalid TypeScript", () => {
    const { typesDTS, indexTS } = emitFrom("");
    expect(typesDTS).toContain("export type EntityUid = never;");
    expect(indexTS).toContain("export const ALL_ACTIONS: readonly ActionUid[] = [];");
  });

  it("sorts registry keys", () => {
    const keys = Object.keys(emitFrom(schema).registry);
    expect(keys).toEqual([...keys].sort());
  });
});
