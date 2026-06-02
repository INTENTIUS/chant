import { describe, test, expect } from "vitest";
import { azureSerializer } from "./serializer";
import { DECLARABLE_MARKER } from "@intentius/chant/declarable";

function makeEntity(entityType: string, props: Record<string, unknown> = {}): any {
  return { [DECLARABLE_MARKER]: true, lexicon: "azure", entityType, kind: "resource", props };
}

describe("azureSerializer ownership stamping (#119)", () => {
  test("stamps the ownership marker as tags when context.ownership is set", () => {
    const entities = new Map<string, any>([
      ["myStorage", makeEntity("Microsoft.Storage/storageAccounts", { name: "mystore", location: "eastus" })],
    ]);
    const out = azureSerializer.serialize(entities, [], { ownership: { stack: "billing", env: "prod" } });
    const template = JSON.parse(out as string);
    const tags = template.resources[0].tags as Record<string, string>;
    expect(tags["chant-managed-by"]).toBe("chant");
    expect(tags["chant-stack"]).toBe("billing");
    expect(tags["chant-env"]).toBe("prod");
    // Azure forbids '/' in tag keys — the marker must not use the label form.
    expect(Object.keys(tags).some((k) => k.includes("/"))).toBe(false);
  });

  test("no ownership context → no chant tags", () => {
    const entities = new Map<string, any>([
      ["myStorage", makeEntity("Microsoft.Storage/storageAccounts", { name: "mystore", location: "eastus" })],
    ]);
    const out = azureSerializer.serialize(entities, []);
    const template = JSON.parse(out as string);
    const tags = (template.resources[0].tags ?? {}) as Record<string, string>;
    expect(Object.keys(tags).some((k) => k.startsWith("chant-"))).toBe(false);
  });
});
