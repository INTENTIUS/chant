import { describe, test, expect } from "vitest";
import { fetchCISchema, fetchSchemas, getCachePath, GITLAB_SCHEMA_VERSION } from "./fetch";

describe("fetch", () => {
  test("fetchCISchema function exists", () => {
    expect(typeof fetchCISchema).toBe("function");
  });

  test("fetchSchemas function exists", () => {
    expect(typeof fetchSchemas).toBe("function");
  });

  test("GITLAB_SCHEMA_VERSION is defined", () => {
    expect(typeof GITLAB_SCHEMA_VERSION).toBe("string");
    expect(GITLAB_SCHEMA_VERSION).toMatch(/^v\d+\.\d+\.\d+-ee$/);
  });

  test("getCachePath returns a path", () => {
    const cachePath = getCachePath();
    expect(typeof cachePath).toBe("string");
    expect(cachePath).toContain("gitlab-ci-schema.json");
  });

  test.skip("integration: fetchCISchema returns Buffer (requires network)", async () => {
    const data = await fetchCISchema();
    expect(data).toBeInstanceOf(Buffer);
    const parsed = JSON.parse(data.toString("utf-8"));
    expect(parsed.properties).toBeDefined();
  });
});
