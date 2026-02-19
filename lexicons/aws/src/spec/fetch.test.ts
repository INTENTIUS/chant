import { describe, test, expect } from "bun:test";
import { fetchSchemaZip } from "./fetch";

describe("fetchSchemaZip", () => {
  test("exports fetchSchemaZip function", () => {
    expect(typeof fetchSchemaZip).toBe("function");
  });

  // Integration test - requires network, skip by default
  test.skip("fetches schema zip from AWS (integration)", async () => {
    const schemas = await fetchSchemaZip();

    // Should have many resource schemas
    expect(schemas.size).toBeGreaterThan(100);

    // Should contain common resource types
    expect(schemas.has("aws-s3-bucket.json")).toBe(true);
    expect(schemas.has("aws-lambda-function.json")).toBe(true);

    // Each schema should be valid JSON
    for (const [name, buffer] of schemas) {
      const text = new TextDecoder().decode(buffer);
      const parsed = JSON.parse(text);
      expect(parsed.typeName).toBeDefined();
    }
  });
});
