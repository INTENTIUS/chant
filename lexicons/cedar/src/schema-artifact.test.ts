/**
 * The project schema as a build artifact (#1697).
 *
 * End to end: a project schema goes in through the plugin's `buildRoots`
 * hook, comes out of the serializer as `schema.cedarschema` beside the
 * policies, and CEDE010 validates against it instead of saying it could not.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Declarable } from "@intentius/chant/declarable";
import type { SerializerResult } from "@intentius/chant/serializer";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { cedarPlugin } from "./plugin";
import { cedarSerializer } from "./serializer";
import { Policy } from "./generated/index";
import { CEDAR_SCHEMA_ENTITY_NAME, CEDAR_SCHEMA_FILENAME, Schema, schemaBuildRoot } from "./schema-artifact";
import { cede010 } from "./lint/post-synth/cede010";

const SCHEMA = `namespace Shop {
  entity Customer = { "email": String };
  entity Order = { "owner": Customer };
  action view appliesTo {
    principal: [Customer],
    resource: [Order],
    context: { "mfa": Bool }
  };
}
`;

function serialize(entities: Map<string, Declarable>): SerializerResult {
  const out = cedarSerializer.serialize(entities);
  if (typeof out === "string") return { primary: out };
  return out;
}

function postSynthCtx(result: SerializerResult): PostSynthContext {
  return {
    outputs: new Map([["cedar", result]]),
    entities: new Map(),
  } as unknown as PostSynthContext;
}

describe("Schema declarable", () => {
  it("is emitted as a .cedarschema beside the policies", () => {
    const entities = new Map<string, Declarable>([
      ["authz", new Schema({ text: SCHEMA })],
      [
        "viewOwn",
        new Policy({
          effect: "permit",
          principal: { is: "Shop::Customer" },
          action: { in: ['Shop::Action::"view"'] },
          resource: { is: "Shop::Order" },
          when: ["resource.owner == principal"],
        }),
      ],
    ]);

    const result = serialize(entities);
    expect(result.files?.[CEDAR_SCHEMA_FILENAME]).toBe(SCHEMA);
    expect(result.primary).toContain("permit");
  });

  it("honours an explicit filename and is emitted even with no policies", () => {
    const entities = new Map<string, Declarable>([["authz", new Schema({ text: SCHEMA, filename: "shop.cedarschema" })]]);
    const result = serialize(entities);
    expect(Object.keys(result.files ?? {})).toEqual(["shop.cedarschema"]);
  });

  it("warns rather than silently overwriting when two schemas share a filename", () => {
    const entities = new Map<string, Declarable>([
      ["a", new Schema({ text: "namespace A { entity X; }\n" })],
      ["b", new Schema({ text: "namespace B { entity Y; }\n" })],
    ]);
    const result = serialize(entities);
    expect(result.files?.[CEDAR_SCHEMA_FILENAME]).toBe("namespace A { entity X; }\n");
    expect(result.warnings?.join("\n")).toMatch(/"b" targets schema\.cedarschema/);
  });

  it("turns CEDE010 from an advisory into validation", () => {
    const badPolicy = new Policy({
      effect: "permit",
      principal: { is: "Shop::Customer" },
      action: { in: ['Shop::Action::"view"'] },
      resource: { is: "Shop::Nope" },
    });

    const without = cede010.check(postSynthCtx(serialize(new Map([["p", badPolicy]]))));
    expect(without.map((d) => d.severity)).toEqual(["info"]);

    const withSchema = cede010.check(
      postSynthCtx(
        serialize(
          new Map<string, Declarable>([
            ["p", badPolicy],
            ["authz", new Schema({ text: SCHEMA })],
          ]),
        ),
      ),
    );
    expect(withSchema.some((d) => d.severity === "error" && /Shop::Nope/.test(d.message))).toBe(true);
  });
});

describe("schemaBuildRoot", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cedar-schema-root-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("contributes the project schema when the project has one", async () => {
    writeFileSync(join(root, "authz.cedarschema"), SCHEMA);
    const contribution = await schemaBuildRoot({
      projectRoot: root,
      config: { cedar: { schema: "authz.cedarschema" } },
    });

    const entity = contribution.entities.get(CEDAR_SCHEMA_ENTITY_NAME);
    expect(entity).toBeDefined();

    const result = serialize(contribution.entities);
    expect(result.files?.["authz.cedarschema"]).toBe(SCHEMA);
  });

  it("finds schema.cedarschema in the project root with no config at all", async () => {
    writeFileSync(join(root, CEDAR_SCHEMA_FILENAME), SCHEMA);
    const contribution = await schemaBuildRoot({ projectRoot: root, config: {} });
    expect(contribution.entities.size).toBe(1);
  });

  it("contributes nothing when only the bundled default schema applies", async () => {
    // Emitting the default would validate a project's policies against an
    // entity model it never wrote; the CEDE010 advisory is the honest outcome.
    const contribution = await schemaBuildRoot({ projectRoot: root, config: {} });
    expect(contribution.entities.size).toBe(0);
  });

  it("is wired into the plugin", async () => {
    writeFileSync(join(root, CEDAR_SCHEMA_FILENAME), SCHEMA);
    const contribution = await cedarPlugin.buildRoots!({ projectRoot: root, config: {} });
    expect(contribution.entities.has(CEDAR_SCHEMA_ENTITY_NAME)).toBe(true);
  });
});
