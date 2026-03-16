import { describe, test, expect } from "bun:test";
import { parseCISchema, gitlabShortName, gitlabServiceName } from "./parse";
import { loadSchemaFixture } from "../testdata/load-fixtures";

const fixture = loadSchemaFixture();

describe("parseCISchema", () => {
  test("returns 19 entities", () => {
    const results = parseCISchema(fixture);
    expect(results).toHaveLength(19);
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

  test("returns 16 property entities", () => {
    const results = parseCISchema(fixture);
    const properties = results.filter((r) => r.isProperty);
    expect(properties).toHaveLength(16);
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
    expect(names).toContain("GitLab::CI::WorkflowRule");
    expect(names).toContain("GitLab::CI::Need");
    expect(names).toContain("GitLab::CI::Inherit");
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

describe("spec conformance — type mappings", () => {
  const results = parseCISchema(fixture);
  const findEntity = (name: string) => results.find((r) => r.resource.typeName === `GitLab::CI::${name}`);
  const findProp = (entityName: string, propName: string) =>
    findEntity(entityName)?.resource.properties.find((p) => p.name === propName);

  test("Job.environment → Environment | string", () => {
    expect(findProp("Job", "environment")?.tsType).toBe("Environment | string");
  });

  test("Job.trigger → Trigger | string", () => {
    expect(findProp("Job", "trigger")?.tsType).toBe("Trigger | string");
  });

  test("Job.release → Release", () => {
    expect(findProp("Job", "release")?.tsType).toBe("Release");
  });

  test("Job.needs → Need[]", () => {
    expect(findProp("Job", "needs")?.tsType).toBe("Need[]");
  });

  test("Job.inherit → Inherit", () => {
    expect(findProp("Job", "inherit")?.tsType).toBe("Inherit");
  });

  test("Workflow.rules → WorkflowRule[]", () => {
    expect(findProp("Workflow", "rules")?.tsType).toBe("WorkflowRule[]");
  });

  test("AllowFailure.exit_codes → number | number[]", () => {
    expect(findProp("AllowFailure", "exit_codes")?.tsType).toBe("number | number[]");
  });

  test("Image.pull_policy has no duplicate enum values", () => {
    const pp = findProp("Image", "pull_policy");
    expect(pp).toBeDefined();
    // Should be clean union with parens on array form
    expect(pp!.tsType).toContain("always");
    expect(pp!.tsType).toContain("never");
    expect(pp!.tsType).toContain("if-not-present");
    // Array variant should use parens
    expect(pp!.tsType).toContain(")[]");
  });

  test("Include has local, remote, template, component fields", () => {
    const include = findEntity("Include");
    expect(include).toBeDefined();
    const propNames = include!.resource.properties.map((p) => p.name);
    expect(propNames).toContain("project");
    expect(propNames).toContain("file");
    expect(propNames).toContain("local");
    expect(propNames).toContain("remote");
    expect(propNames).toContain("template");
    expect(propNames).toContain("component");
  });

  test("Trigger has include field for child pipelines", () => {
    const trigger = findEntity("Trigger");
    expect(trigger).toBeDefined();
    const propNames = trigger!.resource.properties.map((p) => p.name);
    expect(propNames).toContain("project");
    expect(propNames).toContain("include");
    expect(propNames).toContain("strategy");
    expect(propNames).toContain("forward");
  });

  test("Need has merged properties from all object variants", () => {
    const need = findEntity("Need");
    expect(need).toBeDefined();
    const propNames = need!.resource.properties.map((p) => p.name);
    expect(propNames).toContain("job");
    expect(propNames).toContain("artifacts");
    expect(propNames).toContain("project");
    expect(propNames).toContain("ref");
    expect(propNames).toContain("pipeline");
    expect(propNames).toContain("optional");
    // job should be required (in all object variants)
    const jobProp = need!.resource.properties.find((p) => p.name === "job");
    expect(jobProp?.required).toBe(true);
  });

  test("WorkflowRule has restricted when enum", () => {
    const wr = findEntity("WorkflowRule");
    expect(wr).toBeDefined();
    const propNames = wr!.resource.properties.map((p) => p.name);
    expect(propNames).toContain("if");
    expect(propNames).toContain("when");
    expect(propNames).toContain("auto_cancel");
    const whenProp = wr!.resource.properties.find((p) => p.name === "when");
    expect(whenProp?.tsType).toBe('"always" | "never"');
  });

  test("Inherit has default and variables properties", () => {
    const inherit = findEntity("Inherit");
    expect(inherit).toBeDefined();
    const propNames = inherit!.resource.properties.map((p) => p.name);
    expect(propNames).toContain("default");
    expect(propNames).toContain("variables");
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

describe("deprecatedProperties", () => {
  test("all entities have a deprecatedProperties array", () => {
    const results = parseCISchema(fixture);
    for (const r of results) {
      expect(Array.isArray(r.resource.deprecatedProperties)).toBe(true);
    }
  });

  test("mines deprecation from property description", () => {
    const schema = JSON.stringify({
      definitions: {
        job_template: {
          properties: {
            script: { type: "string" },
            oldProp: { type: "string", description: "Deprecated in 12.0: use newProp instead." },
            newProp: { type: "string", description: "The replacement property" },
          },
        },
      },
    });
    const results = parseCISchema(schema);
    const job = results.find((r) => r.resource.typeName === "GitLab::CI::Job");
    expect(job).toBeDefined();
    expect(job!.resource.deprecatedProperties).toContain("oldProp");
    expect(job!.resource.deprecatedProperties).not.toContain("newProp");
    expect(job!.resource.deprecatedProperties).not.toContain("script");
  });

  test("empty deprecatedProperties when no deprecation signals", () => {
    const schema = JSON.stringify({
      definitions: {
        job_template: {
          properties: {
            script: { type: "string", description: "Commands to run" },
            stage: { type: "string", description: "Pipeline stage" },
          },
        },
      },
    });
    const results = parseCISchema(schema);
    const job = results.find((r) => r.resource.typeName === "GitLab::CI::Job");
    expect(job!.resource.deprecatedProperties).toEqual([]);
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
