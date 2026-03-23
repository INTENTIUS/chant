import { describe, test, expect } from "bun:test";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw033, checkSolrHeapRatio } from "./waw033";

function makeTask(memory: string, image: string, solrHeap?: string) {
  return createPostSynthContext({
    aws: {
      Resources: {
        SolrTask: {
          Type: "AWS::ECS::TaskDefinition",
          Properties: {
            Memory: memory,
            ContainerDefinitions: [
              {
                Name: "app",
                Image: image,
                ...(solrHeap && {
                  Environment: [{ Name: "SOLR_HEAP", Value: solrHeap }],
                }),
              },
            ],
          },
        },
      },
    },
  });
}

describe("WAW033: Solr Heap Ratio", () => {
  test("check metadata", () => {
    expect(waw033.id).toBe("WAW033");
    expect(waw033.description).toContain("SOLR_HEAP");
  });

  test("flags heap > 50% of task memory (string MB)", () => {
    const diags = checkSolrHeapRatio(makeTask("2048", "solr:9", "1500m"));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW033");
    expect(diags[0].severity).toBe("error");
  });

  test("flags heap > 50% specified in gigabytes", () => {
    // 2g = 2048MB, task is 2048MB — 2048 > 1024 (50%)
    const diags = checkSolrHeapRatio(makeTask("2048", "solr:9", "2g"));
    expect(diags).toHaveLength(1);
  });

  test("no diagnostic when heap is within limit", () => {
    // 900m < 50% of 2048 (1024)
    const diags = checkSolrHeapRatio(makeTask("2048", "solr:9", "900m"));
    expect(diags).toHaveLength(0);
  });

  test("no diagnostic when SOLR_HEAP not set", () => {
    const diags = checkSolrHeapRatio(makeTask("2048", "solr:9"));
    expect(diags).toHaveLength(0);
  });

  test("no diagnostic for non-solr image", () => {
    const diags = checkSolrHeapRatio(makeTask("2048", "nginx:latest", "1500m"));
    expect(diags).toHaveLength(0);
  });

  test("detects solr image case-insensitively", () => {
    const diags = checkSolrHeapRatio(makeTask("2048", "myrepo/Solr-Custom:9.7", "1500m"));
    expect(diags).toHaveLength(1);
  });
});
