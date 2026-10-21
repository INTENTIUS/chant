/**
 * Outputs azure can't write as a reference are written as values or named in
 * a warning, never as `[reference('').null]` (#4181).
 */

import { describe, expect, it } from "vitest";
import { AttrRef } from "@intentius/chant";
import { DECLARABLE_MARKER } from "@intentius/chant/declarable";
import { LexiconOutput } from "@intentius/chant/lexicon-output";
import { stackOutput } from "@intentius/chant/stack-output";
import { azureSerializer } from "./serializer";
import { ResourceIdIntrinsic } from "./intrinsics";

function makeEntity(entityType: string, props: Record<string, unknown> = {}): any {
  return { [DECLARABLE_MARKER]: true, lexicon: "azure", entityType, kind: "resource", props };
}

function run(entities: Map<string, any>, outputs: LexiconOutput[]): { template: any; warnings: string[] } {
  const result = azureSerializer.serialize(entities, outputs);
  if (typeof result === "string") return { template: JSON.parse(result), warnings: [] };
  return { template: JSON.parse(result.primary), warnings: result.warnings ?? [] };
}

describe("azure outputs", () => {
  it("writes an attribute output by the resource's ARM name", () => {
    const app = makeEntity("Microsoft.App/containerApps", { name: "web" });
    const out = new LexiconOutput(new AttrRef(app, "latestRevisionFqdn"), "WebFqdn");
    out._setSourceEntity("app");
    const { template, warnings } = run(new Map([["app", app]]), [out]);
    expect(template.outputs.WebFqdn.value).toBe("[reference('web').latestRevisionFqdn]");
    expect(warnings).toEqual([]);
  });

  it("writes literal outputs with their ARM type", () => {
    const { template } = run(new Map(), [
      new LexiconOutput("eastus", "Region"),
      new LexiconOutput(3, "Replicas"),
      new LexiconOutput(true, "Public"),
    ]);
    expect(template.outputs).toEqual({
      Region: { type: "string", value: "eastus" },
      Replicas: { type: "int", value: 3 },
      Public: { type: "bool", value: true },
    });
  });

  it("writes an azure intrinsic output as its expression", () => {
    const { template } = run(new Map(), [new LexiconOutput(new ResourceIdIntrinsic("Microsoft.Storage/storageAccounts", "sa"), "SaId")]);
    expect(template.outputs.SaId.value).toBe("[resourceId('Microsoft.Storage/storageAccounts', 'sa')]");
  });

  it("leaves a CloudFormation intrinsic to aws, without a warning", () => {
    const cfn = { [Symbol.for("chant.intrinsic")]: true, toJSON: () => ({ "Fn::Sub": "x" }) };
    const out = new LexiconOutput(cfn as never, "Sub");
    const { template, warnings } = run(new Map(), [out]);
    expect(template.outputs).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it("writes a string stack output, which the docs show as an ARM expression", () => {
    const so = stackOutput("[resourceId('Microsoft.Storage/storageAccounts', 'sa')]", { lexicon: "azure" });
    const { template } = run(new Map<string, any>([["saId", so]]), []);
    expect(template.outputs.saId.value).toBe("[resourceId('Microsoft.Storage/storageAccounts', 'sa')]");
  });
});
