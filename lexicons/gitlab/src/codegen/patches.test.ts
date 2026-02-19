import { describe, test, expect } from "bun:test";
import { applyPatches, schemaPatches } from "./patches";

describe("applyPatches", () => {
  test("applies patches to matching paths", () => {
    const schema = {
      definitions: {
        job_template: {
          properties: {
            script: { type: "string" },
          },
        },
      },
    };

    const { applied, skipped } = applyPatches(schema as Record<string, unknown>);
    expect(applied.length).toBeGreaterThan(0);
    expect(skipped).toHaveLength(0);
  });

  test("skips patches when path does not exist", () => {
    const schema = { definitions: {} };
    const { applied, skipped } = applyPatches(schema as Record<string, unknown>);
    expect(skipped.length).toBeGreaterThan(0);
  });

  test("adds pages property to job_template", () => {
    const schema = {
      definitions: {
        job_template: {
          properties: {} as Record<string, unknown>,
        },
      },
    };

    applyPatches(schema as Record<string, unknown>);
    expect(schema.definitions.job_template.properties.pages).toBeDefined();
  });

  test("adds manual_confirmation property to job_template", () => {
    const schema = {
      definitions: {
        job_template: {
          properties: {} as Record<string, unknown>,
        },
      },
    };

    applyPatches(schema as Record<string, unknown>);
    expect(schema.definitions.job_template.properties.manual_confirmation).toBeDefined();
  });

  test("adds inputs property to job_template", () => {
    const schema = {
      definitions: {
        job_template: {
          properties: {} as Record<string, unknown>,
        },
      },
    };

    applyPatches(schema as Record<string, unknown>);
    expect(schema.definitions.job_template.properties.inputs).toBeDefined();
  });

  test("does not overwrite existing properties", () => {
    const schema = {
      definitions: {
        job_template: {
          properties: {
            pages: { type: "custom" },
            manual_confirmation: { type: "custom" },
            inputs: { type: "custom" },
          } as Record<string, unknown>,
        },
      },
    };

    applyPatches(schema as Record<string, unknown>);
    // Should not have overwritten existing properties
    expect((schema.definitions.job_template.properties.pages as Record<string, string>).type).toBe("custom");
    expect((schema.definitions.job_template.properties.manual_confirmation as Record<string, string>).type).toBe("custom");
    expect((schema.definitions.job_template.properties.inputs as Record<string, string>).type).toBe("custom");
  });
});

describe("schemaPatches registry", () => {
  test("has patches defined", () => {
    expect(schemaPatches.length).toBeGreaterThan(0);
  });

  test("all patches have required fields", () => {
    for (const patch of schemaPatches) {
      expect(patch.description).toBeTruthy();
      expect(patch.path).toBeTruthy();
      expect(typeof patch.apply).toBe("function");
    }
  });
});
