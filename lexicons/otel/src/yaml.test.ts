import { describe, expect, test } from "vitest";
import { load } from "js-yaml";
import { emitCollectorYaml, isPlainSafe } from "./yaml";

describe("collector YAML emitter", () => {
  test.each([
    ["0.0.0.0:4317", true],
    ["custom.googleapis.com/c1", true],
    ["${env:KEY}", true],
    ["true", false],
    ["8080", false],
    ["1:30", false],
    ["a: b", false],
    ["- x", false],
    ["", false],
    [" x", false],
  ])("isPlainSafe(%j) in block context is %s", (s, safe) => {
    expect(isPlainSafe(s, false)).toBe(safe);
  });

  test("a string with flow indicators is quoted inside a flow list", () => {
    expect(isPlainSafe("${env:KEY}", true)).toBe(false);
    const yaml = emitCollectorYaml({ receivers: { x: { list: ["${env:A}", "b"] } } });
    expect(yaml).toContain('list: ["${env:A}", b]');
    expect((load(yaml) as any).receivers.x.list).toEqual(["${env:A}", "b"]);
  });

  test("lists of maps are block style, nested lists and empty values survive", () => {
    const config = {
      processors: {
        attributes: {
          actions: [
            { key: "env", action: "upsert", value: "prod" },
            { key: "secret", action: "delete" },
          ],
          empty: [],
          nested: [[1, 2], [{ a: 1 }]],
          none: null,
          blank: {},
        },
      },
    };
    const yaml = emitCollectorYaml(config);
    expect(yaml).toContain("    actions:\n      - key: env\n        action: upsert\n        value: prod\n      - key: secret\n");
    expect(load(yaml)).toEqual(config);
  });

  test("a header becomes comment lines above the config", () => {
    const yaml = emitCollectorYaml({ exporters: { debug: {} } }, { header: ["chant: hello"] });
    expect(yaml.startsWith("# chant: hello\n\nexporters:\n  debug: {}\n")).toBe(true);
  });

  test("an empty config is empty", () => {
    expect(emitCollectorYaml({})).toBe("");
  });
});
