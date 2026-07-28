import { describe, test, expect } from "vitest";
import {
  parseOutput,
  relativeAge,
  renderTable,
  evalJsonPath,
  renderJsonPath,
  renderCustomColumns,
  renderJson,
  renderYaml,
  renderName,
} from "./render";
import type { K8sObject } from "@intentius/chant-k8s-client";

describe("parseOutput (chant #1079)", () => {
  test("defaults to text", () => {
    expect(parseOutput(undefined)).toEqual({ kind: "text" });
  });

  test("parses every recognized form", () => {
    expect(parseOutput("wide")).toEqual({ kind: "wide" });
    expect(parseOutput("json")).toEqual({ kind: "json" });
    expect(parseOutput("yaml")).toEqual({ kind: "yaml" });
    expect(parseOutput("name")).toEqual({ kind: "name" });
    expect(parseOutput("chant")).toEqual({ kind: "chant" });
    expect(parseOutput("jsonpath={.metadata.name}")).toEqual({ kind: "jsonpath", expr: "{.metadata.name}" });
    expect(parseOutput("custom-columns=NAME:.metadata.name")).toEqual({
      kind: "custom-columns",
      spec: "NAME:.metadata.name",
    });
  });

  test("go-template is refused by name, not half-implemented", () => {
    expect(() => parseOutput("go-template={{.metadata.name}}")).toThrow(/go-template/);
    expect(() => parseOutput("go-template-file=x.tmpl")).toThrow(/go-template/);
  });

  test("an unrecognized value is refused", () => {
    expect(() => parseOutput("bogus")).toThrow(/unsupported/);
  });
});

describe("relativeAge", () => {
  test("renders seconds, minutes, hours, days", () => {
    const now = Date.parse("2026-01-02T00:00:00Z");
    expect(relativeAge("2026-01-02T00:00:00Z", now)).toBe("0s");
    expect(relativeAge("2026-01-01T23:59:30Z", now)).toBe("30s");
    expect(relativeAge("2026-01-01T23:50:00Z", now)).toBe("10m");
    expect(relativeAge("2026-01-01T18:00:00Z", now)).toBe("6h");
    expect(relativeAge("2025-12-30T00:00:00Z", now)).toBe("3d");
  });

  test("undefined/unparseable input is honest, not a crash", () => {
    expect(relativeAge(undefined)).toBe("<unknown>");
    expect(relativeAge("not-a-date")).toBe("<unknown>");
  });
});

describe("renderTable", () => {
  test("pads columns to the widest cell and trims trailing whitespace", () => {
    const out = renderTable(["NAME", "AGE"], [["web", "3d"], ["a-much-longer-name", "1h"]]);
    const lines = out.split("\n");
    expect(lines[0]).toBe("NAME                AGE");
    expect(lines[2]).toBe("a-much-longer-name  1h");
  });
});

describe("jsonpath (subset)", () => {
  const root = { metadata: { name: "web" }, items: [{ metadata: { name: "a" } }, { metadata: { name: "b" } }] };

  test("a dot path extracts a scalar", () => {
    expect(evalJsonPath("{.metadata.name}", root)).toBe("web");
  });

  test("a wildcard collects and space-joins matches", () => {
    expect(evalJsonPath("{.items[*].metadata.name}", root)).toBe("a b");
  });

  test("an index selects one element", () => {
    expect(evalJsonPath("{.items[1].metadata.name}", root)).toBe("b");
  });

  test("literal text and quoted literals pass through untouched", () => {
    expect(evalJsonPath('name={.metadata.name}{"!"}', root)).toBe("name=web!");
  });

  test("renderJsonPath wraps >1 object in a synthetic List, matching kubectl", () => {
    const objects = [
      { apiVersion: "v1", kind: "Pod", metadata: { name: "a" } },
      { apiVersion: "v1", kind: "Pod", metadata: { name: "b" } },
    ] as K8sObject[];
    expect(renderJsonPath("{.items[*].metadata.name}", objects)).toBe("a b");
  });

  test("a single object is printed bare, not wrapped in a List", () => {
    const objects = [{ apiVersion: "v1", kind: "Pod", metadata: { name: "a" } }] as K8sObject[];
    expect(renderJsonPath("{.metadata.name}", objects)).toBe("a");
  });
});

describe("custom-columns", () => {
  test("renders a header per entry and evaluates its path per object", () => {
    const objects = [
      { apiVersion: "v1", kind: "Pod", metadata: { name: "a", namespace: "prod" } },
      { apiVersion: "v1", kind: "Pod", metadata: { name: "b", namespace: "staging" } },
    ] as K8sObject[];
    const out = renderCustomColumns("NAME:.metadata.name,NS:.metadata.namespace", objects);
    expect(out).toContain("NAME");
    expect(out).toContain("NS");
    expect(out).toMatch(/a\s+prod/);
    expect(out).toMatch(/b\s+staging/);
  });

  test("a missing ':' is a clear parse error", () => {
    expect(() => renderCustomColumns("NAME.metadata.name", [])).toThrow(/":"/);
  });
});

describe("json / yaml / name", () => {
  const one = [{ apiVersion: "v1", kind: "Pod", metadata: { name: "a" } }] as K8sObject[];
  const many = [
    { apiVersion: "v1", kind: "Pod", metadata: { name: "a" } },
    { apiVersion: "v1", kind: "Pod", metadata: { name: "b" } },
  ] as K8sObject[];

  test("a single object prints bare in json/yaml", () => {
    expect(JSON.parse(renderJson(one)).metadata.name).toBe("a");
    expect(renderYaml(one)).toContain("name: a");
  });

  test("multiple objects wrap in a List", () => {
    expect(JSON.parse(renderJson(many)).kind).toBe("List");
    expect(renderYaml(many)).toContain("kind: List");
  });

  test("-o name renders <kind>.<group>/<name>, or <kind>/<name> for the core group", () => {
    expect(renderName([{ apiVersion: "v1", kind: "Pod", metadata: { name: "a" } }] as K8sObject[])).toBe("pod/a");
    expect(
      renderName([{ apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "web" } }] as K8sObject[]),
    ).toBe("deployment.apps/web");
  });
});
