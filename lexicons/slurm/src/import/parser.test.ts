/**
 * SlurmConfParser tests.
 */

import { describe, test, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { SlurmConfParser } from "./parser";

const testdata = (file: string) =>
  readFileSync(join(import.meta.dirname, "testdata", file), "utf8");

describe("SlurmConfParser", () => {
  test("returns empty entities for empty input", () => {
    const { entities } = new SlurmConfParser().parse("");
    expect(entities).toHaveLength(0);
  });

  test("parses ClusterName from simple.conf", () => {
    const { entities } = new SlurmConfParser().parse(testdata("simple.conf"));
    const cluster = entities.find((e) => e.kind === "cluster");
    expect(cluster).toBeDefined();
    expect(cluster!.props.ClusterName).toBe("hpc-dev");
  });

  test("parses ControlMachine from simple.conf", () => {
    const { entities } = new SlurmConfParser().parse(testdata("simple.conf"));
    const cluster = entities.find((e) => e.kind === "cluster");
    expect(cluster!.props.ControlMachine).toBe("head01");
  });

  test("parses AuthType from simple.conf", () => {
    const { entities } = new SlurmConfParser().parse(testdata("simple.conf"));
    const cluster = entities.find((e) => e.kind === "cluster");
    expect(cluster!.props.AuthType).toBe("auth/munge");
  });

  test("parses SelectType from simple.conf", () => {
    const { entities } = new SlurmConfParser().parse(testdata("simple.conf"));
    const cluster = entities.find((e) => e.kind === "cluster");
    expect(cluster!.props.SelectType).toBe("select/cons_tres");
  });

  test("parses Node from simple.conf", () => {
    const { entities } = new SlurmConfParser().parse(testdata("simple.conf"));
    const node = entities.find((e) => e.kind === "node");
    expect(node).toBeDefined();
    expect(node!.props.NodeName).toBe("node[001-004]");
    expect(node!.props.CPUs).toBe(32);
    expect(node!.props.RealMemory).toBe(65536);
  });

  test("parses Partition from simple.conf", () => {
    const { entities } = new SlurmConfParser().parse(testdata("simple.conf"));
    const partition = entities.find((e) => e.kind === "partition");
    expect(partition).toBeDefined();
    expect(partition!.props.PartitionName).toBe("cpu");
    expect(partition!.props.Default).toBe("YES");
    expect(partition!.props.MaxTime).toBe("7-00:00:00");
  });

  test("extracts Licenses= as separate License entities in eda-cluster.conf", () => {
    const { entities } = new SlurmConfParser().parse(testdata("eda-cluster.conf"));
    const licenses = entities.filter((e) => e.kind === "license");
    expect(licenses.length).toBeGreaterThanOrEqual(2);
    const vcsSim = licenses.find((l) => l.props.LicenseName === "vcs_sim");
    expect(vcsSim).toBeDefined();
    expect(vcsSim!.props.Count).toBe(200);
  });

  test("parses GPU node Gres from eda-cluster.conf", () => {
    const { entities } = new SlurmConfParser().parse(testdata("eda-cluster.conf"));
    const gpuNode = entities.find((e) => e.kind === "node" && String(e.name).startsWith("gpu"));
    expect(gpuNode).toBeDefined();
    expect(gpuNode!.props.Gres).toBe("gpu:a100:8");
    expect(gpuNode!.props.Feature).toBe("efa");
  });

  test("parses multiple partitions from eda-cluster.conf", () => {
    const { entities } = new SlurmConfParser().parse(testdata("eda-cluster.conf"));
    const partitions = entities.filter((e) => e.kind === "partition");
    expect(partitions.length).toBeGreaterThanOrEqual(3);
    const partNames = partitions.map((p) => p.props.PartitionName);
    expect(partNames).toContain("synthesis");
    expect(partNames).toContain("sim");
    expect(partNames).toContain("gpu_eda");
  });

  test("strips comments from lines", () => {
    const conf = "# This is a comment\nClusterName=test # inline comment\n";
    const { entities } = new SlurmConfParser().parse(conf);
    const cluster = entities.find((e) => e.kind === "cluster");
    expect(cluster!.props.ClusterName).toBe("test");
  });

  test("ignores blank lines", () => {
    const conf = "\n\nClusterName=test\n\nControlMachine=head01\n\n";
    const { entities } = new SlurmConfParser().parse(conf);
    expect(entities.length).toBeGreaterThan(0);
  });

  test("coerces numeric values to numbers", () => {
    const conf = "NodeName=node001 CPUs=96 RealMemory=196608 Weight=10 State=UNKNOWN\n";
    const { entities } = new SlurmConfParser().parse(conf);
    const node = entities.find((e) => e.kind === "node");
    expect(typeof node!.props.CPUs).toBe("number");
    expect(node!.props.CPUs).toBe(96);
  });
});
