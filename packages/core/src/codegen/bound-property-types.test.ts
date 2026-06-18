import { describe, test, expect } from "vitest";
import { boundPropertyTypes, type BoundablePropertyType } from "./bound-property-types";

interface Prop {
  name: string;
  tsType: string;
}
interface PT extends BoundablePropertyType {
  name: string;
  specType: string;
  properties: Prop[];
}

function pt(name: string, props: Array<[string, string]>): PT {
  return { name, specType: name.split("_")[1] ?? name, properties: props.map(([n, t]) => ({ name: n, tsType: t })) };
}

describe("boundPropertyTypes", () => {
  test("drops property types unreachable from resource props", () => {
    const props: Prop[] = [{ name: "sku", tsType: "R_Sku" }];
    const types = [pt("R_Sku", [["name", "string"]]), pt("R_Unused", [["x", "string"]])];
    const kept = boundPropertyTypes("R", props, types, new Set(), { maxDepth: 2 });
    expect(kept.map((t) => t.name)).toEqual(["R_Sku"]);
  });

  test("caps nesting depth and loosens references beyond the cap", () => {
    const props: Prop[] = [{ name: "a", tsType: "R_A" }];
    const types = [
      pt("R_A", [["b", "R_B"]]),
      pt("R_B", [["c", "R_C"]]),
      pt("R_C", [["d", "string"]]),
    ];
    const kept = boundPropertyTypes("R", props, types, new Set(), { maxDepth: 1 });
    // depth 1: R_A kept, its child R_B not expanded -> loosened, R_C dropped
    expect(kept.map((t) => t.name)).toEqual(["R_A"]);
    expect(kept[0].properties[0].tsType).toBe("Record<string, unknown>");
    expect(props[0].tsType).toBe("R_A"); // resource prop ref to a kept type is preserved
  });

  test("force-keeps curated property types by substring regardless of reachability", () => {
    const props: Prop[] = [];
    const types = [pt("R_SecurityRulePropertiesFormat", [["x", "string"]]), pt("R_Other", [["y", "string"]])];
    const kept = boundPropertyTypes("R", props, types, new Set(), {
      maxDepth: 1,
      curatedDefs: ["SecurityRule"],
    });
    expect(kept.map((t) => t.name)).toEqual(["R_SecurityRulePropertiesFormat"]);
  });

  test("preserves enum references when loosening", () => {
    const props: Prop[] = [{ name: "a", tsType: "R_A" }];
    const types = [pt("R_A", [["mode", "R_ModeEnum"], ["nested", "R_Deep"]]), pt("R_Deep", [["x", "string"]])];
    const kept = boundPropertyTypes("R", props, types, new Set(["R_ModeEnum"]), { maxDepth: 1 });
    expect(kept[0].properties[0].tsType).toBe("R_ModeEnum"); // enum kept
    expect(kept[0].properties[1].tsType).toBe("Record<string, unknown>"); // deep type loosened
  });
});
