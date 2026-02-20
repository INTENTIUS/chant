import { describe, test, expect } from "bun:test";
import { parseCISchema, gitlabShortName, gitlabServiceName } from "./parse";
import { loadSchemaFixture } from "../testdata/load-fixtures";

const fixture = loadSchemaFixture();

describe("parseCISchema", () => {
  test("returns 16 entities", () => {
    const results = parseCISchema(fixture);
    expect(results).toHaveLength(16);
  });

  test("returns 3 resource entities", () => {
    const results = parseCISchema(fixture);
    const resources = results.filter((r) => !r.isProperty);
    expect(resources).toHaveLength(3);
    const names = resources.map((r) => r.resource.typeName);
    expect(names).toContain("GitLab::CI::Job");
    expect(names).toContain("GitLab::CI::Default");
    expect(names).toContain("GitLab::CI::Workflow");
  });

  test("returns 13 property entities", () => {
    const results = parseCISchema(fixture);
    const properties = results.filter((r) => r.isProperty);
    expect(properties).toHaveLength(13);
    const names = properties.map((r) => r.resource.typeName);
    expect(names).toContain("GitLab::CI::Artifacts");
    expect(names).toContain("GitLab::CI::Cache");
    expect(names).toContain("GitLab::CI::Image");
    expect(names).toContain("GitLab::CI::Service");
    expect(names).toContain("GitLab::CI::Rule");
    expect(names).toContain("GitLab::CI::Retry");
    expect(names).toContain("GitLab::CI::AllowFailure");
    expect(names).toContain("GitLab::CI::Parallel");
    expect(names).toContain("GitLab::CI::Include");
    expect(names).toContain("GitLab::CI::Release");
    expect(names).toContain("GitLab::CI::Environment");
    expect(names).toContain("GitLab::CI::Trigger");
    expect(names).toContain("GitLab::CI::AutoCancel");
  });

  test("property entities have isProperty set to true", () => {
    const results = parseCISchema(fixture);
    const properties = results.filter((r) => r.isProperty);
    for (const p of properties) {
      expect(p.isProperty).toBe(true);
    }
  });

  test("resource entities do not have isProperty set", () => {
    const results = parseCISchema(fixture);
    const resources = results.filter((r) => !r.isProperty);
    for (const r of resources) {
      expect(r.isProperty).toBeUndefined();
    }
  });
});

describe("Job entity", () => {
  test("has expected properties", () => {
    const results = parseCISchema(fixture);
    const job = results.find((r) => r.resource.typeName === "GitLab::CI::Job");
    expect(job).toBeDefined();
    const propNames = job!.resource.properties.map((p) => p.name);
    expect(propNames).toContain("script");
    expect(propNames).toContain("stage");
    expect(propNames).toContain("image");
    expect(propNames).toContain("artifacts");
    expect(propNames).toContain("cache");
    expect(propNames).toContain("before_script");
    expect(propNames).toContain("after_script");
    expect(propNames).toContain("rules");
    expect(propNames).toContain("when");
    expect(propNames).toContain("environment");
    expect(propNames).toContain("variables");
  });

  test("has no attributes (CI entities have no read-only attrs)", () => {
    const results = parseCISchema(fixture);
    const job = results.find((r) => r.resource.typeName === "GitLab::CI::Job");
    expect(job!.resource.attributes).toEqual([]);
  });

  test("has a description", () => {
    const results = parseCISchema(fixture);
    const job = results.find((r) => r.resource.typeName === "GitLab::CI::Job");
    expect(job!.resource.description).toBeDefined();
    expect(typeof job!.resource.description).toBe("string");
  });
});

describe("Image entity", () => {
  test("has name property marked as required", () => {
    const results = parseCISchema(fixture);
    const image = results.find((r) => r.resource.typeName === "GitLab::CI::Image");
    expect(image).toBeDefined();
    const nameProp = image!.resource.properties.find((p) => p.name === "name");
    expect(nameProp).toBeDefined();
    expect(nameProp!.required).toBe(true);
    expect(nameProp!.tsType).toBe("string");
  });
});

describe("Artifacts entity", () => {
  test("has paths and expire_in properties", () => {
    const results = parseCISchema(fixture);
    const artifacts = results.find((r) => r.resource.typeName === "GitLab::CI::Artifacts");
    expect(artifacts).toBeDefined();
    const propNames = artifacts!.resource.properties.map((p) => p.name);
    expect(propNames).toContain("paths");
    expect(propNames).toContain("expire_in");
  });
});

describe("Cache entity", () => {
  test("has key, paths, and policy properties", () => {
    const results = parseCISchema(fixture);
    const cache = results.find((r) => r.resource.typeName === "GitLab::CI::Cache");
    expect(cache).toBeDefined();
    const propNames = cache!.resource.properties.map((p) => p.name);
    expect(propNames).toContain("key");
    expect(propNames).toContain("paths");
    expect(propNames).toContain("policy");
  });
});

describe("property types and enums", () => {
  test("entities have empty propertyTypes (nested types extracted as top-level)", () => {
    const results = parseCISchema(fixture);
    for (const r of results) {
      expect(r.propertyTypes).toEqual([]);
    }
  });

  test("entities have empty enums (enums extracted separately)", () => {
    const results = parseCISchema(fixture);
    for (const r of results) {
      expect(r.enums).toEqual([]);
    }
  });
});

describe("edge cases", () => {
  test("empty schema returns empty results", () => {
    const emptySchema = JSON.stringify({ definitions: {} });
    const results = parseCISchema(emptySchema);
    expect(results).toHaveLength(0);
  });

  test("schema with missing definitions returns partial results", () => {
    const partial = JSON.stringify({
      definitions: {
        job_template: {
          properties: {
            script: { type: "string" },
          },
        },
      },
    });
    const results = parseCISchema(partial);
    // Should get at least the Job entity
    expect(results.length).toBeGreaterThan(0);
    const job = results.find((r) => r.resource.typeName === "GitLab::CI::Job");
    expect(job).toBeDefined();
  });

  test("accepts Buffer input", () => {
    const results = parseCISchema(fixture);
    expect(results.length).toBeGreaterThan(0);
  });

  test("accepts string input", () => {
    const results = parseCISchema(fixture.toString("utf-8"));
    expect(results.length).toBeGreaterThan(0);
  });
});

describe("gitlabShortName", () => {
  test("extracts short name from type", () => {
    expect(gitlabShortName("GitLab::CI::Job")).toBe("Job");
    expect(gitlabShortName("GitLab::CI::Artifacts")).toBe("Artifacts");
    expect(gitlabShortName("GitLab::CI::AutoCancel")).toBe("AutoCancel");
  });
});

describe("gitlabServiceName", () => {
  test("extracts service name from type", () => {
    expect(gitlabServiceName("GitLab::CI::Job")).toBe("CI");
    expect(gitlabServiceName("GitLab::CI::Cache")).toBe("CI");
  });

  test("returns CI for short names", () => {
    expect(gitlabServiceName("Job")).toBe("CI");
  });
});
