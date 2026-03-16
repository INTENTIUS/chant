import { describe, test, expect } from "bun:test";
import { fetchK8sSchema, fetchSchemas, K8S_SCHEMA_VERSION } from "./fetch";

describe("fetch", () => {
  test("fetchK8sSchema function exists", () => {
    expect(typeof fetchK8sSchema).toBe("function");
  });

  test("fetchSchemas function exists", () => {
    expect(typeof fetchSchemas).toBe("function");
  });

  test("K8S_SCHEMA_VERSION is defined", () => {
    expect(typeof K8S_SCHEMA_VERSION).toBe("string");
    expect(K8S_SCHEMA_VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  test.skip("integration: fetchK8sSchema returns Buffer (requires network)", async () => {
    const data = await fetchK8sSchema();
    expect(data).toBeInstanceOf(Buffer);
    const parsed = JSON.parse(data.toString("utf-8"));
    expect(parsed.definitions).toBeDefined();
  });
});
