import { describe, expect, it } from "vitest";
import type { Declarable } from "@intentius/chant/declarable";
import { terraformSerializer } from "./serializer";
import { RESOURCE_TYPE, TERRAFORM_TYPE, terraformEntity } from "./hcl/parse";

describe("terraform serializer", () => {
  it("has the contract's two required members", () => {
    expect(terraformSerializer.name).toBe("terraform");
    expect(terraformSerializer.rulePrefix).toBe("TF");
  });

  it("emits an empty string for an empty map", () => {
    expect(terraformSerializer.serialize(new Map())).toBe("");
  });

  it("emits no output for parsed root entities, the .tf files are the artifact", () => {
    const entities = new Map<string, Declarable>([
      ["app/terraform", terraformEntity(TERRAFORM_TYPE, "terraform", {}, "main.tf", "app")],
      [
        "app/null_resource.first",
        terraformEntity(RESOURCE_TYPE, "null_resource.first", { triggers: {} }, "main.tf", "app"),
      ],
    ]);
    expect(terraformSerializer.serialize(entities)).toBe("");
  });
});
