/**
 * Composite unit tests — GpuPartition and EDACluster.
 */

import { describe, test, expect } from "bun:test";
import { GpuPartition } from "./gpu-partition";
import { EDACluster } from "./eda-cluster";

// ── GpuPartition ──────────────────────────────────────────────────

describe("GpuPartition: basic", () => {
  test("returns nodes and partition", () => {
    const result = GpuPartition({
      partitionName: "gpu_eda",
      nodePattern: "gpu[001-004]",
      gpuTypeCount: "a100:8",
      cpusPerNode: 96,
      memoryMb: 1_044_480,
    });
    expect(result.nodes).toBeDefined();
    expect(result.partition).toBeDefined();
    expect(result.gresNode).toBeUndefined();
  });

  test("gresConf emits gresNode in result", () => {
    const result = GpuPartition({
      partitionName: "gpu_eda",
      nodePattern: "gpu[001-016]",
      gpuTypeCount: "a100:8",
      cpusPerNode: 96,
      memoryMb: 1_044_480,
      gresConf: { autoDetect: "nvml" },
    });
    expect(result.gresNode).toBeDefined();
    const props = (result.gresNode as unknown as { props: Record<string, unknown> }).props;
    expect(props.NodeName).toBe("gpu[001-016]");
    expect(props.Name).toBe("gpu");
    expect(props.Type).toBe("a100");
    expect(props.AutoDetect).toBe("nvml");
  });

  test("gresConf with file sets File prop", () => {
    const result = GpuPartition({
      partitionName: "gpu",
      nodePattern: "gpu[001-004]",
      gpuTypeCount: "h100:8",
      cpusPerNode: 96,
      memoryMb: 1_044_480,
      gresConf: { autoDetect: "off", file: "/dev/nvidia[0-7]" },
    });
    expect(result.gresNode).toBeDefined();
    const props = (result.gresNode as unknown as { props: Record<string, unknown> }).props;
    expect(props.AutoDetect).toBe("off");
    expect(props.File).toBe("/dev/nvidia[0-7]");
  });

  test("topology wires CoresPerSocket and ThreadsPerCore on node", () => {
    const result = GpuPartition({
      partitionName: "gpu_eda",
      nodePattern: "gpu[001-016]",
      gpuTypeCount: "a100:8",
      cpusPerNode: 96,
      memoryMb: 1_044_480,
      socketsPerNode: 2,
      coresPerSocket: 48,
      threadsPerCore: 1,
    });
    const props = (result.nodes as unknown as { props: Record<string, unknown> }).props;
    expect(props.Sockets).toBe(2);
    expect(props.CoresPerSocket).toBe(48);
    expect(props.ThreadsPerCore).toBe(1);
  });
});

// ── EDACluster ────────────────────────────────────────────────────

const BASE_CONFIG = {
  clusterName: "hpc-eda",
  controlMachine: "head01",
  accountingHost: "db.internal",
  stateSaveLocation: "/fsx/slurm/state",
  cpuNodes: { pattern: "cpu[001-032]", cpusPerNode: 36, memoryMb: 71680, count: 32 },
} as const;

describe("EDACluster: healthCheck", () => {
  test("wires HealthCheckProgram and HealthCheckInterval on cluster", () => {
    const result = EDACluster({
      ...BASE_CONFIG,
      healthCheck: { program: "/usr/sbin/nhc", interval: 30, nodeState: "ANY" },
    });
    const props = (result.cluster as unknown as { props: Record<string, unknown> }).props;
    expect(props.HealthCheckProgram).toBe("/usr/sbin/nhc");
    expect(props.HealthCheckInterval).toBe(30);
    expect(props.HealthCheckNodeState).toBe("ANY");
  });
});

describe("EDACluster: mpiDefault", () => {
  test("wires MpiDefault on cluster", () => {
    const result = EDACluster({ ...BASE_CONFIG, mpiDefault: "pmix" });
    const props = (result.cluster as unknown as { props: Record<string, unknown> }).props;
    expect(props.MpiDefault).toBe("pmix");
  });
});

describe("EDACluster: returnToService defaults", () => {
  test("defaults ReturnToService to 1 when suspend is configured", () => {
    const result = EDACluster({
      ...BASE_CONFIG,
      suspend: {
        program: "/usr/local/bin/suspend",
        resumeProgram: "/usr/local/bin/resume",
        suspendTime: 300,
        resumeTimeout: 600,
      },
    });
    const props = (result.cluster as unknown as { props: Record<string, unknown> }).props;
    expect(props.ReturnToService).toBe(1);
  });

  test("does not set ReturnToService when suspend is not configured", () => {
    const result = EDACluster({ ...BASE_CONFIG });
    const props = (result.cluster as unknown as { props: Record<string, unknown> }).props;
    expect(props.ReturnToService).toBeUndefined();
  });

  test("explicit returnToService overrides default", () => {
    const result = EDACluster({
      ...BASE_CONFIG,
      suspend: {
        program: "/usr/local/bin/suspend",
        resumeProgram: "/usr/local/bin/resume",
        suspendTime: 300,
        resumeTimeout: 600,
      },
      returnToService: 2,
    });
    const props = (result.cluster as unknown as { props: Record<string, unknown> }).props;
    expect(props.ReturnToService).toBe(2);
  });
});

describe("EDACluster: cpuNode topology", () => {
  test("wires coresPerSocket and threadsPerCore onto cpuNode", () => {
    const result = EDACluster({
      ...BASE_CONFIG,
      cpuNodes: {
        pattern: "cpu[001-032]",
        cpusPerNode: 36,
        memoryMb: 71680,
        count: 32,
        socketsPerNode: 2,
        coresPerSocket: 9,
        threadsPerCore: 2,
      },
    });
    const props = (result.cpuNodes as unknown as { props: Record<string, unknown> }).props;
    expect(props.Sockets).toBe(2);
    expect(props.CoresPerSocket).toBe(9);
    expect(props.ThreadsPerCore).toBe(2);
  });
});

describe("EDACluster: gresNode from gpuNodes", () => {
  test("returns gresNode when gpuNodes.gresConf provided", () => {
    const result = EDACluster({
      ...BASE_CONFIG,
      gpuNodes: {
        partitionName: "gpu_eda",
        nodePattern: "gpu[001-016]",
        gpuTypeCount: "a100:8",
        cpusPerNode: 96,
        memoryMb: 1_044_480,
        gresConf: { autoDetect: "nvml" },
      },
    });
    expect(result.gresNode).toBeDefined();
  });

  test("does not return gresNode when gpuNodes.gresConf not provided", () => {
    const result = EDACluster({
      ...BASE_CONFIG,
      gpuNodes: {
        partitionName: "gpu_eda",
        nodePattern: "gpu[001-016]",
        gpuTypeCount: "a100:8",
        cpusPerNode: 96,
        memoryMb: 1_044_480,
      },
    });
    expect(result.gresNode).toBeUndefined();
  });
});

describe("EDACluster: cgroupConf option", () => {
  test("creates cgroupConf resource with correct props", () => {
    const result = EDACluster({
      ...BASE_CONFIG,
      cgroupConf: { plugin: "cgroup/v2", allowedRAMSpace: 90, minRAMSpace: 50 },
    });
    expect(result.cgroupConf).toBeDefined();
    const props = (result.cgroupConf as unknown as { props: Record<string, unknown> }).props;
    expect(props.CgroupPlugin).toBe("cgroup/v2");
    expect(props.ConstrainRAMSpace).toBe(true);
    expect(props.ConstrainCores).toBe(true);
    expect(props.AllowedRAMSpace).toBe(90);
    expect(props.MinRAMSpace).toBe(50);
  });

  test("cgroupConf auto-sets ConstrainDevices=true when gpuNodes present", () => {
    const result = EDACluster({
      ...BASE_CONFIG,
      cgroupConf: {},
      gpuNodes: {
        partitionName: "gpu_eda",
        nodePattern: "gpu[001-016]",
        gpuTypeCount: "a100:8",
        cpusPerNode: 96,
        memoryMb: 1_044_480,
      },
    });
    const props = (result.cgroupConf as unknown as { props: Record<string, unknown> }).props;
    expect(props.ConstrainDevices).toBe(true);
  });

  test("cgroupConf does not set ConstrainDevices when no gpuNodes", () => {
    const result = EDACluster({ ...BASE_CONFIG, cgroupConf: {} });
    const props = (result.cgroupConf as unknown as { props: Record<string, unknown> }).props;
    expect(props.ConstrainDevices).toBeUndefined();
  });

  test("cgroupConf not in result when option not provided", () => {
    const result = EDACluster({ ...BASE_CONFIG });
    expect(result.cgroupConf).toBeUndefined();
  });
});

describe("EDACluster: suspend extensions", () => {
  const SUSPEND_CONFIG = {
    ...BASE_CONFIG,
    suspend: {
      program: "/usr/local/bin/suspend",
      resumeProgram: "/usr/local/bin/resume",
      suspendTime: 300,
      resumeTimeout: 600,
    },
  } as const;

  test("suspend.excludeNodes wires SuspendExcNodes onto cluster", () => {
    const result = EDACluster({
      ...SUSPEND_CONFIG,
      suspend: { ...SUSPEND_CONFIG.suspend, excludeNodes: "head01" },
    });
    const props = (result.cluster as unknown as { props: Record<string, unknown> }).props;
    expect(props.SuspendExcNodes).toBe("head01");
  });

  test("suspend.excludeParts wires SuspendExcParts onto cluster", () => {
    const result = EDACluster({
      ...SUSPEND_CONFIG,
      suspend: { ...SUSPEND_CONFIG.suspend, excludeParts: "gpu_eda" },
    });
    const props = (result.cluster as unknown as { props: Record<string, unknown> }).props;
    expect(props.SuspendExcParts).toBe("gpu_eda");
  });

  test("suspend.resumeRate wires ResumeRate onto cluster", () => {
    const result = EDACluster({
      ...SUSPEND_CONFIG,
      suspend: { ...SUSPEND_CONFIG.suspend, resumeRate: 10 },
    });
    const props = (result.cluster as unknown as { props: Record<string, unknown> }).props;
    expect(props.ResumeRate).toBe(10);
  });

  test("suspend.suspendRate wires SuspendRate onto cluster", () => {
    const result = EDACluster({
      ...SUSPEND_CONFIG,
      suspend: { ...SUSPEND_CONFIG.suspend, suspendRate: 5 },
    });
    const props = (result.cluster as unknown as { props: Record<string, unknown> }).props;
    expect(props.SuspendRate).toBe(5);
  });

  test("synthesis partition gets PowerDownOnIdle=YES when suspend configured", () => {
    const result = EDACluster({ ...SUSPEND_CONFIG });
    const props = (result.synthesisPartition as unknown as { props: Record<string, unknown> }).props;
    expect(props.PowerDownOnIdle).toBe("YES");
  });

  test("sim partition gets PowerDownOnIdle=YES when suspend configured", () => {
    const result = EDACluster({ ...SUSPEND_CONFIG });
    const props = (result.simPartition as unknown as { props: Record<string, unknown> }).props;
    expect(props.PowerDownOnIdle).toBe("YES");
  });

  test("partitions do not get PowerDownOnIdle when suspend not configured", () => {
    const result = EDACluster({ ...BASE_CONFIG });
    const sp = (result.synthesisPartition as unknown as { props: Record<string, unknown> }).props;
    expect(sp.PowerDownOnIdle).toBeUndefined();
  });
});

describe("EDACluster: acctGatherEnergy", () => {
  test("wires AcctGatherEnergyType and AcctGatherNodeFreq onto cluster", () => {
    const result = EDACluster({
      ...BASE_CONFIG,
      acctGatherEnergy: { type: "gpu", nodeFreq: 30 },
    });
    const props = (result.cluster as unknown as { props: Record<string, unknown> }).props;
    expect(props.AcctGatherEnergyType).toBe("acct_gather_energy/gpu");
    expect(props.AcctGatherNodeFreq).toBe(30);
  });

  test("wires AcctGatherEnergyType without nodeFreq when not set", () => {
    const result = EDACluster({
      ...BASE_CONFIG,
      acctGatherEnergy: { type: "ipmi" },
    });
    const props = (result.cluster as unknown as { props: Record<string, unknown> }).props;
    expect(props.AcctGatherEnergyType).toBe("acct_gather_energy/ipmi");
    expect(props.AcctGatherNodeFreq).toBeUndefined();
  });
});

describe("EDACluster: preemptType", () => {
  test("wires PreemptType onto cluster", () => {
    const result = EDACluster({ ...BASE_CONFIG, preemptType: "preempt/qos" });
    const props = (result.cluster as unknown as { props: Record<string, unknown> }).props;
    expect(props.PreemptType).toBe("preempt/qos");
  });
});
