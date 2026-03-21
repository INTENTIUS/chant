/**
 * Post-synth check tests — SLR010 through SLR021.
 */

import { describe, test, expect } from "bun:test";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { slr010 } from "./slr010-cluster-required";
import { slr011 } from "./slr011-partition-has-nodes";
import { slr012 } from "./slr012-gres-gpu-type";
import { slr013 } from "./slr013-auth-munge";
import { slr014 } from "./slr014-state-save-location";
import { slr015 } from "./slr015-cons-tres-params";
import { slr016 } from "./slr016-select-type-deprecated";
import { slr017 } from "./slr017-def-mem-conflict";
import { slr018 } from "./slr018-gres-types-required";
import { slr019 } from "./slr019-accounting-enforce";
import { slr020 } from "./slr020-proctrack-cgroup";
import { slr021 } from "./slr021-priority-fairshare";
import { slr022 } from "./slr022-default-partition";
import { slr023 } from "./slr023-node-state-valid";
import { slr024 } from "./slr024-suspend-resume-pair";

function makeCtx(conf: string): PostSynthContext {
  return {
    outputs: new Map([["slurm", conf]]),
    entities: new Map(),
    buildResult: {
      outputs: new Map([["slurm", conf]]),
      entities: new Map(),
      warnings: [],
      errors: [],
      sourceFileCount: 1,
    },
  };
}

// ── SLR010 ────────────────────────────────────────────────────────

describe("SLR010: cluster required", () => {
  test("flags missing ClusterName", () => {
    const diags = slr010.check(makeCtx("ControlMachine=head01\n"));
    expect(diags.some((d) => d.message.includes("ClusterName"))).toBe(true);
  });

  test("flags missing ControlMachine", () => {
    const diags = slr010.check(makeCtx("ClusterName=hpc\n"));
    expect(diags.some((d) => d.message.includes("ControlMachine"))).toBe(true);
  });

  test("passes when both present", () => {
    const diags = slr010.check(makeCtx("ClusterName=hpc\nControlMachine=head01\n"));
    expect(diags).toHaveLength(0);
  });
});

// ── SLR011 ────────────────────────────────────────────────────────

describe("SLR011: partition has nodes", () => {
  test("flags undefined node reference in partition", () => {
    const conf = "NodeName=cpu[001-004] CPUs=32\nPartitionName=gpu Nodes=gpu[001-004] MaxTime=UNLIMITED\n";
    const diags = slr011.check(makeCtx(conf));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("SLR011");
  });

  test("passes when partition nodes are defined", () => {
    const conf = "NodeName=cpu[001-004] CPUs=32\nPartitionName=cpu Nodes=cpu[001-004]\n";
    const diags = slr011.check(makeCtx(conf));
    expect(diags).toHaveLength(0);
  });
});

// ── SLR012 ────────────────────────────────────────────────────────

describe("SLR012: GPU GRES type", () => {
  test("flags untyped GPU GRES", () => {
    const conf = "NodeName=gpu001 Gres=gpu:8 CPUs=96\n";
    const diags = slr012.check(makeCtx(conf));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("SLR012");
  });

  test("passes for typed GPU GRES", () => {
    const conf = "NodeName=gpu001 Gres=gpu:a100:8 CPUs=96\n";
    const diags = slr012.check(makeCtx(conf));
    expect(diags).toHaveLength(0);
  });
});

// ── SLR013 ────────────────────────────────────────────────────────

describe("SLR013: auth/none", () => {
  test("flags AuthType=auth/none", () => {
    const conf = "ClusterName=hpc\nAuthType=auth/none\n";
    const diags = slr013.check(makeCtx(conf));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].severity).toBe("error");
  });

  test("passes for auth/munge", () => {
    const conf = "ClusterName=hpc\nAuthType=auth/munge\n";
    const diags = slr013.check(makeCtx(conf));
    expect(diags).toHaveLength(0);
  });
});

// ── SLR014 ────────────────────────────────────────────────────────

describe("SLR014: StateSaveLocation", () => {
  test("warns for local-only path", () => {
    const conf = "StateSaveLocation=/var/spool/slurm\n";
    const diags = slr014.check(makeCtx(conf));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].severity).toBe("warning");
  });

  test("passes for NFS path", () => {
    const conf = "StateSaveLocation=/nfs/slurm/state\n";
    const diags = slr014.check(makeCtx(conf));
    expect(diags).toHaveLength(0);
  });

  test("passes for FSx path", () => {
    const conf = "StateSaveLocation=/fsx/slurm/state\n";
    const diags = slr014.check(makeCtx(conf));
    expect(diags).toHaveLength(0);
  });
});

// ── SLR015 ────────────────────────────────────────────────────────

describe("SLR015: cons_tres needs SelectTypeParameters", () => {
  test("warns when cons_tres set without parameters", () => {
    const conf = "SelectType=select/cons_tres\n";
    const diags = slr015.check(makeCtx(conf));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("SLR015");
  });

  test("passes when SelectTypeParameters is set", () => {
    const conf = "SelectType=select/cons_tres\nSelectTypeParameters=CR_Core_Memory\n";
    const diags = slr015.check(makeCtx(conf));
    expect(diags).toHaveLength(0);
  });
});

// ── SLR016 ────────────────────────────────────────────────────────

describe("SLR016: cons_res deprecated", () => {
  test("warns for select/cons_res", () => {
    const conf = "SelectType=select/cons_res\n";
    const diags = slr016.check(makeCtx(conf));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("SLR016");
  });

  test("does not warn for cons_tres", () => {
    const conf = "SelectType=select/cons_tres\nSelectTypeParameters=CR_Core_Memory\n";
    const diags = slr016.check(makeCtx(conf));
    expect(diags).toHaveLength(0);
  });
});

// ── SLR017 ────────────────────────────────────────────────────────

describe("SLR017: DefMem conflict", () => {
  test("flags partition with both DefMemPerCPU and DefMemPerNode", () => {
    const conf = "PartitionName=cpu Nodes=node[001-004] DefMemPerCPU=2048 DefMemPerNode=65536\n";
    const diags = slr017.check(makeCtx(conf));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("SLR017");
    expect(diags[0].severity).toBe("error");
  });

  test("passes when only DefMemPerCPU set", () => {
    const conf = "PartitionName=cpu Nodes=node[001-004] DefMemPerCPU=2048\n";
    const diags = slr017.check(makeCtx(conf));
    expect(diags).toHaveLength(0);
  });
});

// ── SLR018 ────────────────────────────────────────────────────────

describe("SLR018: GresTypes=gpu required", () => {
  test("flags GPU nodes without GresTypes=gpu", () => {
    const conf = "NodeName=gpu001 Gres=gpu:a100:8\n";
    const diags = slr018.check(makeCtx(conf));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("SLR018");
  });

  test("passes when GresTypes=gpu is set", () => {
    const conf = "GresTypes=gpu\nNodeName=gpu001 Gres=gpu:a100:8\n";
    const diags = slr018.check(makeCtx(conf));
    expect(diags).toHaveLength(0);
  });
});

// ── SLR019 ────────────────────────────────────────────────────────

describe("SLR019: AccountingStorageEnforce", () => {
  test("warns for slurmdbd without enforce", () => {
    const conf = "AccountingStorageType=accounting_storage/slurmdbd\n";
    const diags = slr019.check(makeCtx(conf));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("SLR019");
  });

  test("passes with AccountingStorageEnforce set", () => {
    const conf = "AccountingStorageType=accounting_storage/slurmdbd\nAccountingStorageEnforce=associations,limits,qos\n";
    const diags = slr019.check(makeCtx(conf));
    expect(diags).toHaveLength(0);
  });
});

// ── SLR020 ────────────────────────────────────────────────────────

describe("SLR020: proctrack/linuxproc unsafe", () => {
  test("warns for proctrack/linuxproc", () => {
    const conf = "ProctrackType=proctrack/linuxproc\n";
    const diags = slr020.check(makeCtx(conf));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].severity).toBe("warning");
  });

  test("passes for proctrack/cgroup", () => {
    const conf = "ProctrackType=proctrack/cgroup\n";
    const diags = slr020.check(makeCtx(conf));
    expect(diags).toHaveLength(0);
  });
});

// ── SLR021 ────────────────────────────────────────────────────────

describe("SLR021: PriorityWeightFairshare too low", () => {
  test("warns for low fairshare weight", () => {
    const conf = "PriorityWeightFairshare=10\n";
    const diags = slr021.check(makeCtx(conf));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("SLR021");
  });

  test("passes for weight >= 1000", () => {
    const conf = "PriorityWeightFairshare=10000\n";
    const diags = slr021.check(makeCtx(conf));
    expect(diags).toHaveLength(0);
  });

  test("passes when PriorityWeightFairshare is not set", () => {
    const conf = "ClusterName=hpc\n";
    const diags = slr021.check(makeCtx(conf));
    expect(diags).toHaveLength(0);
  });
});

// ── SLR022 ────────────────────────────────────────────────────────

describe("SLR022: default partition", () => {
  test("warns when no partition has Default=YES", () => {
    const conf = "PartitionName=cpu Nodes=node[001-004] MaxTime=UNLIMITED\n";
    const diags = slr022.check(makeCtx(conf));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("SLR022");
  });

  test("warns when multiple partitions have Default=YES", () => {
    const conf = "PartitionName=cpu Nodes=node[001-004] Default=YES\nPartitionName=gpu Nodes=gpu[001-002] Default=YES\n";
    const diags = slr022.check(makeCtx(conf));
    expect(diags.length).toBeGreaterThanOrEqual(1);
  });

  test("passes with exactly one Default=YES", () => {
    const conf = "PartitionName=cpu Nodes=node[001-004] Default=YES\nPartitionName=gpu Nodes=gpu[001-002] Default=NO\n";
    const diags = slr022.check(makeCtx(conf));
    expect(diags).toHaveLength(0);
  });
});

// ── SLR023 ────────────────────────────────────────────────────────

describe("SLR023: node state valid", () => {
  test("warns for invalid initial state UP", () => {
    const conf = "NodeName=node001 CPUs=32 State=UP\n";
    const diags = slr023.check(makeCtx(conf));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("SLR023");
  });

  test("passes for UNKNOWN state", () => {
    const conf = "NodeName=node001 CPUs=32 State=UNKNOWN\n";
    expect(slr023.check(makeCtx(conf))).toHaveLength(0);
  });

  test("passes for CLOUD state", () => {
    const conf = "NodeName=node001 CPUs=32 State=CLOUD\n";
    expect(slr023.check(makeCtx(conf))).toHaveLength(0);
  });
});

// ── SLR024 ────────────────────────────────────────────────────────

describe("SLR024: suspend/resume pair", () => {
  test("errors when SuspendProgram set without ResumeProgram", () => {
    const conf = "SuspendProgram=/usr/local/bin/suspend_node\n";
    const diags = slr024.check(makeCtx(conf));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].severity).toBe("error");
  });

  test("warns when ResumeProgram set without SuspendProgram", () => {
    const conf = "ResumeProgram=/usr/local/bin/resume_node\n";
    const diags = slr024.check(makeCtx(conf));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].severity).toBe("warning");
  });

  test("passes when both are set", () => {
    const conf = "SuspendProgram=/usr/local/bin/suspend\nResumeProgram=/usr/local/bin/resume\n";
    expect(slr024.check(makeCtx(conf))).toHaveLength(0);
  });

  test("passes when neither is set", () => {
    const conf = "ClusterName=hpc\n";
    expect(slr024.check(makeCtx(conf))).toHaveLength(0);
  });
});
