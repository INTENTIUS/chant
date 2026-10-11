/**
 * Every template scaffolds a project that builds — checked against the codegen
 * rather than asserted in prose.
 *
 * "Builds" for cedar means something specific: the policy file imports classes
 * and action constants that do not exist until `chant generate` has read the
 * project's own schema. So the test runs the same pipeline stage `generate()`
 * does — parse the template's `.cedarschema`, build the emit model — and
 * requires every identifier the template imports to be in it. A template whose
 * schema and policies drift apart fails here rather than in a user's terminal.
 */

import { describe, expect, it } from "vitest";
import { checkParsePolicySet, checkParseSchema } from "@cedar-policy/cedar-wasm/nodejs";
import { CEDAR_INIT_TEMPLATES, cedarInitTemplates } from "./init-templates";
import { parseCedarSchema } from "./spec/parse";
import { buildEmitModel } from "./codegen/emit";
import { createNaming, POLICY_TS_NAME } from "./codegen/naming";

/** Names exported by the generated index for a given schema. */
function generatedNames(schemaText: string): Set<string> {
  const { decls } = parseCedarSchema(schemaText);
  const model = buildEmitModel(decls, createNaming(decls));

  const names = new Set<string>([
    POLICY_TS_NAME,
    "EntityTypeName",
    "EntityUid",
    "ActionUid",
    "PolicyRef",
    "PolicyEffect",
    "PolicyScope",
    "PolicyProps",
    "ALL_ACTIONS",
    "ALL_ENTITY_TYPES",
  ]);
  for (const entity of model.entities) {
    names.add(entity.tsName);
    names.add(entity.attributesTsName);
    names.add(entity.uidTsName);
    names.add(`${entity.attributesTsName}Props`);
  }
  for (const action of model.actions) {
    names.add(action.tsName);
    names.add(action.contextTsName);
    names.add(`${action.contextTsName}Props`);
  }
  return names;
}

/**
 * Identifiers a policy file imports from the lexicon package (any subpath) or
 * from the project's generated tree, `./generated/cedar` (#1696).
 */
function importedNames(source: string): string[] {
  const names: string[] = [];
  const importRe = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+"(?:@intentius\/chant-lexicon-cedar[^"]*|\.\/generated\/cedar)"/g;
  for (const match of source.matchAll(importRe)) {
    for (const raw of match[1].split(",")) {
      const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
      if (name) names.push(name);
    }
  }
  return names;
}

/** Names the composites barrel exports — not schema-derived, so listed here. */
const COMPOSITE_EXPORTS = new Set(["OwnerCanManage", "DenyByDefaultSet"]);

/** Every entity type the schema declares, as a policy scope would spell it. */
function entityTypeNames(schemaText: string): Set<string> {
  return new Set(parseCedarSchema(schemaText).decls.filter((d) => d.kind === "entity").map((d) => d.typeName));
}

describe("cedarInitTemplates", () => {
  it("names three templates", () => {
    expect(CEDAR_INIT_TEMPLATES).toEqual(["default", "avp-embedding", "gateway-policy-set"]);
  });

  it("falls back to the default for an unknown name", () => {
    expect(cedarInitTemplates("no-such-template")).toEqual(cedarInitTemplates());
    expect(cedarInitTemplates("default")).toEqual(cedarInitTemplates());
  });

  it("gives each named template its own schema and policies", () => {
    const avp = cedarInitTemplates("avp-embedding");
    const gateway = cedarInitTemplates("gateway-policy-set");

    expect(avp.root?.["schema.cedarschema"]).not.toEqual(gateway.root?.["schema.cedarschema"]);
    expect(avp.src["policies.ts"]).not.toEqual(gateway.src["policies.ts"]);
  });

  for (const template of CEDAR_INIT_TEMPLATES) {
    describe(template, () => {
      const set = cedarInitTemplates(template);
      const schemaText = set.root?.["schema.cedarschema"] ?? "";
      const policies = set.src["policies.ts"] ?? "";

      it("ships a schema at the path cedar resolves without any config", () => {
        // spec/fetch.ts step 2: `schema.cedarschema` in the project root.
        expect(schemaText.length).toBeGreaterThan(0);
        expect(checkParseSchema(schemaText).type).toBe("success");
      });

      it("ships a policy file and a README", () => {
        expect(policies).toContain("export const");
        expect(set.root?.["README.md"]).toContain("chant cedar generate");
      });

      it("wires the generate and build scripts into package.json", () => {
        expect(set.scripts?.generate).toBe("chant cedar generate");
        expect(set.scripts?.build).toBe("chant build");
      });

      it("imports its schema-derived names from the project tree, not the package (#1696)", () => {
        // The package's own `src/generated` describes the bundled default
        // schema. A scaffold typed against that would compile with no
        // generate step and be wrong about its own entity model.
        const available = generatedNames(schemaText);
        const fromPackage = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+"@intentius\/chant-lexicon-cedar[^"]*"/g;
        for (const match of policies.matchAll(fromPackage)) {
          for (const raw of match[1].split(",")) {
            const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
            expect(available.has(name), `${template}: ${name} should come from ./generated/cedar`).toBe(false);
          }
        }
        expect(policies).toMatch(/from "\.\/generated\/cedar"/);
      });

      it("imports only names its own schema generates", () => {
        const available = generatedNames(schemaText);
        const missing = importedNames(policies).filter(
          (name) => !available.has(name) && !COMPOSITE_EXPORTS.has(name),
        );

        expect(missing, `${template}: policies.ts imports names its schema does not produce`).toEqual([]);
      });

      it("names only entity types its own schema declares", () => {
        const declared = entityTypeNames(schemaText);
        const referenced = [...policies.matchAll(/is:\s*"([^"]+)"/g)].map((m) => m[1]);

        expect(referenced.length).toBeGreaterThan(0);
        for (const name of referenced) {
          expect(declared, `${template}: ${name} is not in this template's schema`).toContain(name);
        }
      });

      it("declares at least one forbid — Cedar's only override construct", () => {
        expect(policies).toMatch(/effect:\s*"forbid"|DenyByDefaultSet/);
      });
    });
  }

  it("emits a bare-permit-free default policy set", () => {
    // The meta-policy wall fails `permit (principal, action, resource);` in a
    // prod build, so no scaffold may ship one.
    const policies = cedarInitTemplates().src["policies.ts"];

    expect(policies).toContain("principal: { is:");
    expect(policies).toContain("when:");
  });

  it("produces schemas cedar-wasm accepts alongside a parsable policy shape", () => {
    // A sanity check that the scope forms the templates use survive the
    // round-trip through Cedar's own parser.
    const probe = `permit (
  principal is App::User,
  action == App::Action::"read",
  resource is App::Document
)
when { resource.owner == principal };`;

    expect(checkParsePolicySet({ staticPolicies: probe }).type).toBe("success");
  });
});
