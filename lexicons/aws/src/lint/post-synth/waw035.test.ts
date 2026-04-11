import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw035, checkSolrUlimits } from "./waw035";

function makeTask(image: string, ulimits?: unknown[]) {
  return createPostSynthContext({
    aws: {
      Resources: {
        SolrTask: {
          Type: "AWS::ECS::TaskDefinition",
          Properties: {
            Memory: "4096",
            ContainerDefinitions: [
              {
                Name: "app",
                Image: image,
                ...(ulimits && { Ulimits: ulimits }),
              },
            ],
          },
        },
      },
    },
  });
}

describe("WAW035: Solr nofile Ulimit", () => {
  test("check metadata", () => {
    expect(waw035.id).toBe("WAW035");
    expect(waw035.description).toContain("nofile");
  });

  test("flags Solr container with no ulimits", () => {
    const diags = checkSolrUlimits(makeTask("solr:9"));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW035");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("not set");
  });

  test("flags Solr container with nofile below minimum", () => {
    const diags = checkSolrUlimits(makeTask("solr:9", [
      { Name: "nofile", SoftLimit: 1024, HardLimit: 1024 },
    ]));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("1024");
  });

  test("no diagnostic when nofile >= 65535", () => {
    const diags = checkSolrUlimits(makeTask("solr:9", [
      { Name: "nofile", SoftLimit: 65535, HardLimit: 65535 },
    ]));
    expect(diags).toHaveLength(0);
  });

  test("no diagnostic when nofile HardLimit > 65535", () => {
    const diags = checkSolrUlimits(makeTask("solr:9", [
      { Name: "nofile", SoftLimit: 65535, HardLimit: 131072 },
    ]));
    expect(diags).toHaveLength(0);
  });

  test("no diagnostic for non-solr image", () => {
    const diags = checkSolrUlimits(makeTask("nginx:latest"));
    expect(diags).toHaveLength(0);
  });

  test("flags when only nproc ulimit set but nofile missing", () => {
    const diags = checkSolrUlimits(makeTask("solr:9", [
      { Name: "nproc", SoftLimit: 65535, HardLimit: 65535 },
    ]));
    expect(diags).toHaveLength(1);
  });
});
