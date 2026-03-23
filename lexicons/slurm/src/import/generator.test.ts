/**
 * SlurmGenerator tests.
 */

import { describe, test, expect } from "bun:test";
import { SlurmGenerator } from "./generator";
import type { SlurmIR } from "./parser";

describe("SlurmGenerator", () => {
  test("returns no-entity comment for empty input", () => {
    const { source } = new SlurmGenerator().generate([]);
    expect(source).toContain("No entities");
  });

  test("generates Cluster constructor", () => {
    const entities: SlurmIR[] = [{
      kind: "cluster",
      name: "hpcProd",
      props: { ClusterName: "hpc-prod", ControlMachine: "head01" },
    }];
    const { source } = new SlurmGenerator().generate(entities);
    expect(source).toContain("new Cluster(");
    expect(source).toContain("ClusterName");
    expect(source).toContain("hpc-prod");
  });

  test("generates Node constructor", () => {
    const entities: SlurmIR[] = [{
      kind: "node",
      name: "computeNodes",
      props: { NodeName: "node[001-016]", CPUs: 96 },
    }];
    const { source } = new SlurmGenerator().generate(entities);
    expect(source).toContain("new Node(");
    expect(source).toContain("NodeName");
  });

  test("generates Partition constructor", () => {
    const entities: SlurmIR[] = [{
      kind: "partition",
      name: "sim",
      props: { PartitionName: "sim", MaxTime: "7-00:00:00" },
    }];
    const { source } = new SlurmGenerator().generate(entities);
    expect(source).toContain("new Partition(");
    expect(source).toContain("MaxTime");
  });

  test("generates License constructor", () => {
    const entities: SlurmIR[] = [{
      kind: "license",
      name: "vcs_sim",
      props: { LicenseName: "vcs_sim", Count: 200 },
    }];
    const { source } = new SlurmGenerator().generate(entities);
    expect(source).toContain("new License(");
    expect(source).toContain("LicenseName");
    expect(source).toContain("200");
  });

  test("import line includes only needed types", () => {
    const entities: SlurmIR[] = [
      { kind: "cluster", name: "c", props: { ClusterName: "test" } },
      { kind: "node", name: "n", props: { NodeName: "node001" } },
    ];
    const { source } = new SlurmGenerator().generate(entities);
    expect(source).toContain("import { Cluster, Node }");
    expect(source).not.toContain("Partition");
    expect(source).not.toContain("License");
  });

  test("sanitizes kebab-case names to camelCase", () => {
    const entities: SlurmIR[] = [{ kind: "partition", name: "gpu-eda", props: { PartitionName: "gpu-eda" } }];
    const { source } = new SlurmGenerator().generate(entities);
    expect(source).toContain("export const gpuEda");
  });

  test("sanitizes bracketed node names — identifier has no brackets", () => {
    const entities: SlurmIR[] = [{ kind: "node", name: "node[001-016]", props: { NodeName: "node[001-016]" } }];
    const { source } = new SlurmGenerator().generate(entities);
    // Brackets removed from the export const identifier
    expect(source).toContain("export const node");
    // The variable name itself should not have brackets
    const exportLine = source.split("\n").find((l) => l.startsWith("export const "))!;
    expect(exportLine).not.toContain("[");
  });

  test("import statement comes before exports", () => {
    const entities: SlurmIR[] = [{ kind: "cluster", name: "hpc", props: {} }];
    const { source } = new SlurmGenerator().generate(entities);
    const importIdx = source.indexOf("import {");
    const exportIdx = source.indexOf("export const");
    expect(importIdx).toBeLessThan(exportIdx);
  });

  test("multiple entity types → sorted combined import", () => {
    const entities: SlurmIR[] = [
      { kind: "partition", name: "p", props: {} },
      { kind: "cluster", name: "c", props: {} },
      { kind: "node", name: "n", props: {} },
    ];
    const { source } = new SlurmGenerator().generate(entities);
    // Types should be sorted alphabetically in import
    expect(source).toContain("Cluster, Node, Partition");
  });
});
