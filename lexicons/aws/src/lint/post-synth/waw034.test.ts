import { describe, test, expect } from "bun:test";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw034, checkSolrMemoryMinimum } from "./waw034";

function makeTask(memory: string, image: string) {
  return createPostSynthContext({
    aws: {
      Resources: {
        SolrTask: {
          Type: "AWS::ECS::TaskDefinition",
          Properties: {
            Memory: memory,
            ContainerDefinitions: [{ Name: "app", Image: image }],
          },
        },
      },
    },
  });
}

describe("WAW034: Solr Memory Minimum", () => {
  test("check metadata", () => {
    expect(waw034.id).toBe("WAW034");
    expect(waw034.description).toContain("2048");
  });

  test("flags task with 512MB", () => {
    const diags = checkSolrMemoryMinimum(makeTask("512", "solr:9"));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW034");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("512MB");
  });

  test("flags task with 1024MB", () => {
    const diags = checkSolrMemoryMinimum(makeTask("1024", "solr:9"));
    expect(diags).toHaveLength(1);
  });

  test("no diagnostic at exactly 2048MB", () => {
    const diags = checkSolrMemoryMinimum(makeTask("2048", "solr:9"));
    expect(diags).toHaveLength(0);
  });

  test("no diagnostic at 4096MB", () => {
    const diags = checkSolrMemoryMinimum(makeTask("4096", "solr:9"));
    expect(diags).toHaveLength(0);
  });

  test("no diagnostic for non-solr image", () => {
    const diags = checkSolrMemoryMinimum(makeTask("512", "postgres:16"));
    expect(diags).toHaveLength(0);
  });
});
