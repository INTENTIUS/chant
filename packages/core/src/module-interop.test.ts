import { describe, expect, test } from "vitest";
import { selectConfigExport } from "./config-sandbox";
import { esModuleNamespace } from "./module-interop";

/** What node's native import() hands back for a CommonJS module tsx compiled from `export default`. */
function commonJsNamespace(exports: Record<string, unknown>): Record<string, unknown> {
  const moduleExports: Record<string, unknown> = { ...exports };
  Object.defineProperty(moduleExports, "__esModule", { value: true });
  return { ...exports, default: moduleExports };
}

describe("esModuleNamespace (#3897)", () => {
  test("a CommonJS __esModule namespace reads as the module's own exports", () => {
    const config = { lexicons: ["terraform"] };
    const helper = () => 1;
    const ns = esModuleNamespace(commonJsNamespace({ default: config, helper }));
    expect(ns.default).toBe(config);
    expect(ns.helper).toBe(helper);
    expect(Object.keys(ns)).not.toContain("__esModule");
  });

  test("a CommonJS module with no default export has none after unwrapping", () => {
    const ns = esModuleNamespace(commonJsNamespace({ config: { lexicons: ["aws"] } }));
    expect(ns.default).toBeUndefined();
    expect(ns.config).toEqual({ lexicons: ["aws"] });
  });

  test("an enumerable __esModule marker is left out too", () => {
    const ns = esModuleNamespace({ default: { __esModule: true, default: 1 } });
    expect(ns).toEqual({ default: 1 });
  });

  test("an ES module whose default export has a default key is unchanged", () => {
    const namespace = { default: { default: { lexicons: ["aws"] } } };
    expect(esModuleNamespace(namespace)).toBe(namespace);
  });

  test("a default without the marker set to true is unchanged", () => {
    const namespace = { default: { __esModule: "yes", default: 1 } };
    expect(esModuleNamespace(namespace)).toBe(namespace);
    const primitive = { default: 3 };
    expect(esModuleNamespace(primitive)).toBe(primitive);
    const empty = {};
    expect(esModuleNamespace(empty)).toBe(empty);
  });
});

describe("selectConfigExport (#3897)", () => {
  test("a config tsx compiled as CommonJS selects the config object, not {default: config}", () => {
    const config = { lexicons: ["terraform"], terraform: { roots: { estate: { dir: "estate" } } } };
    expect(selectConfigExport(commonJsNamespace({ default: config }))).toBe(config);
  });

  test("an ES module config that legitimately has a default key keeps it", () => {
    const config = { default: { lexicons: ["aws"] }, lexicons: ["aws"] };
    expect(selectConfigExport({ default: config })).toBe(config);
  });

  test("a require()d CommonJS config still selects its default", () => {
    const config = { lexicons: ["aws"] };
    const moduleExports: Record<string, unknown> = { default: config };
    Object.defineProperty(moduleExports, "__esModule", { value: true });
    expect(selectConfigExport(moduleExports)).toBe(config);
  });
});
