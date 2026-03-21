/**
 * Slurm serializer tests — 12 required test cases from the authoring guide.
 */

import { describe, expect, it } from "bun:test";
import { slurmSerializer } from "./serializer";
import { DECLARABLE_MARKER } from "@intentius/chant/declarable";

// ── Test helpers ─────────────────────────────────────────────────

function makeEntity(
  entityType: string,
  props: Record<string, unknown>,
): Record<string, unknown> {
  return {
    [DECLARABLE_MARKER]: true,
    entityType,
    lexicon: "slurm",
    kind: "resource",
    props,
    attributes: {},
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe("slurm serializer", () => {
  it("has the correct name", () => {
    expect(slurmSerializer.name).toBe("slurm");
  });

  it("has rulePrefix SLR", () => {
    expect(slurmSerializer.rulePrefix).toBe("SLR");
  });

  it("serializes empty map to slurm.conf comment header", () => {
    const result = slurmSerializer.serialize(new Map());
    expect(typeof result).toBe("string");
    expect(result as string).toContain("slurm.conf");
  });

  it("emits ClusterName and ControlMachine from Cluster entity", () => {
    const entities = new Map([
      ["myCluster", makeEntity("Slurm::Conf::Cluster", {
        ClusterName: "hpc-prod",
        ControlMachine: "head01",
        AuthType: "auth/munge",
      })],
    ]);
    const result = slurmSerializer.serialize(entities) as string;
    expect(result).toContain("ClusterName=hpc-prod");
    expect(result).toContain("ControlMachine=head01");
    expect(result).toContain("AuthType=auth/munge");
  });

  it("emits NodeName stanza from Node entity", () => {
    const entities = new Map([
      ["computeNodes", makeEntity("Slurm::Conf::Node", {
        NodeName: "node[001-016]",
        CPUs: 96,
        RealMemory: 196608,
        State: "UNKNOWN",
      })],
    ]);
    const result = slurmSerializer.serialize(entities) as string;
    expect(result).toContain("NodeName=node[001-016]");
    expect(result).toContain("CPUs=96");
    expect(result).toContain("RealMemory=196608");
  });

  it("emits PartitionName stanza from Partition entity", () => {
    const entities = new Map([
      ["cpuPart", makeEntity("Slurm::Conf::Partition", {
        PartitionName: "cpu",
        Nodes: "node[001-016]",
        Default: "YES",
        MaxTime: "7-00:00:00",
      })],
    ]);
    const result = slurmSerializer.serialize(entities) as string;
    expect(result).toContain("PartitionName=cpu");
    expect(result).toContain("Nodes=node[001-016]");
    expect(result).toContain("Default=YES");
  });

  it("aggregates multiple License entities into a single Licenses= line", () => {
    const entities = new Map([
      ["lic1", makeEntity("Slurm::Conf::License", { LicenseName: "vcs_sim", Count: 200 })],
      ["lic2", makeEntity("Slurm::Conf::License", { LicenseName: "calibre", Count: 30 })],
    ]);
    const result = slurmSerializer.serialize(entities) as string;
    expect(result).toContain("Licenses=");
    expect(result).toContain("vcs_sim:200");
    expect(result).toContain("calibre:30");
  });

  it("returns SerializerResult when REST entities present", () => {
    const entities = new Map([
      ["myJob", makeEntity("Slurm::Rest::Job", { name: "test-job", partition: "cpu", script: "#!/bin/bash\necho hello" })],
      ["cluster", makeEntity("Slurm::Conf::Cluster", { ClusterName: "dev", ControlMachine: "head01" })],
    ]);
    const result = slurmSerializer.serialize(entities);
    expect(typeof result).toBe("object");
    const r = result as { primary: string; files: Record<string, string> };
    expect(r.primary).toContain("ClusterName=dev");
    expect(r.files["jobs/myJob.json"]).toBeDefined();
  });

  it("serializes Job REST entity to JSON file", () => {
    const entities = new Map([
      ["trainingJob", makeEntity("Slurm::Rest::Job", {
        name: "gpu-train",
        partition: "gpu_eda",
        node_count: 4,
        gres_per_node: "gpu:a100:8",
        exclusive: true,
        time_limit: 1440,
        script: "#!/bin/bash\ntorchrun train.py",
      })],
    ]);
    const result = slurmSerializer.serialize(entities) as { primary: string; files: Record<string, string> };
    const jobJson = JSON.parse(result.files["jobs/trainingJob.json"]);
    expect(jobJson.name).toBe("gpu-train");
    expect(jobJson.node_count).toBe(4);
    expect(jobJson.exclusive).toBe(true);
  });

  it("serializes Reservation REST entity to reservations/ subdirectory", () => {
    const entities = new Map([
      ["maintenanceWindow", makeEntity("Slurm::Rest::Reservation", {
        name: "maintenance-2024",
        node_count: 4,
        duration: 480,
        flags: "MAINTENANCE",
      })],
    ]);
    const result = slurmSerializer.serialize(entities) as { primary: string; files: Record<string, string> };
    expect(result.files["reservations/maintenanceWindow.json"]).toBeDefined();
    const resJson = JSON.parse(result.files["reservations/maintenanceWindow.json"]);
    expect(resJson.name).toBe("maintenance-2024");
  });

  it("serializes QoS REST entity to qos/ subdirectory", () => {
    const entities = new Map([
      ["highPriority", makeEntity("Slurm::Rest::QoS", {
        name: "high",
        priority: 1000,
        max_wall_clock_per_job: 86400,
      })],
    ]);
    const result = slurmSerializer.serialize(entities) as { primary: string; files: Record<string, string> };
    expect(result.files["qos/highPriority.json"]).toBeDefined();
  });

  it("omits undefined/null props from slurm.conf output", () => {
    const entities = new Map([
      ["cluster", makeEntity("Slurm::Conf::Cluster", {
        ClusterName: "test",
        ControlMachine: "head01",
        AccountingStorageType: undefined,
        GresTypes: null,
      })],
    ]);
    const result = slurmSerializer.serialize(entities) as string;
    expect(result).not.toContain("AccountingStorageType");
    expect(result).not.toContain("GresTypes");
  });

  it("emits Gres and Feature in Node stanza", () => {
    const entities = new Map([
      ["gpuNodes", makeEntity("Slurm::Conf::Node", {
        NodeName: "gpu[001-004]",
        CPUs: 96,
        RealMemory: 1048576,
        Gres: "gpu:a100:8",
        Feature: "efa,a100",
        State: "UNKNOWN",
      })],
    ]);
    const result = slurmSerializer.serialize(entities) as string;
    expect(result).toContain("Gres=gpu:a100:8");
    expect(result).toContain("Feature=efa,a100");
  });
});
