import { describe, test, expect } from "vitest";
import { AttrRef } from "@intentius/chant/attrref";
import { EksCluster } from "./eks-cluster";

const subnets = ["subnet-aaa", "subnet-bbb"];

describe("EksCluster", () => {
  test("control-plane-only: cluster + its role, wired by AttrRef", () => {
    const c = EksCluster({ name: "kmv-dev", subnetIds: subnets });
    expect(c.cluster).toBeDefined();
    expect(c.clusterRole).toBeDefined();
    expect((c as unknown as Record<string, unknown>).nodegroup).toBeUndefined();
    const clusterProps = (c.cluster as any).props;
    expect(clusterProps.RoleArn).toBeInstanceOf(AttrRef);
    expect(clusterProps.ResourcesVpcConfig.SubnetIds).toEqual(subnets);
  });

  // The composite's return is a union (nodegroup-less vs full), and the
  // repo-wide typecheck rightly refuses to narrow it structurally — tests go
  // through a member map, the same access the expander itself uses.
  type Members = Record<string, { props?: Record<string, any> } | undefined>;

  test("with a nodegroup: node role carries the three worker policies, nodes default into the cluster subnets", () => {
    const c = EksCluster({
      name: "kmv-prod",
      subnetIds: subnets,
      version: "1.31",
      nodegroup: { desiredSize: 2 },
    }) as unknown as Members;
    expect(c.nodegroup).toBeDefined();
    expect(c.nodeRole).toBeDefined();
    const ngProps = c.nodegroup!.props!;
    expect(ngProps.ClusterName).toBe("kmv-prod");
    expect(ngProps.Subnets).toEqual(subnets);
    expect(ngProps.ScalingConfig.MinSize).toBe(2);
    expect(ngProps.ScalingConfig.MaxSize).toBe(2);
    expect(c.nodeRole!.props!.ManagedPolicyArns).toHaveLength(3);
  });

  test("nodegroup subnets override; scaling bounds honor explicit min/max", () => {
    const c = EksCluster({
      name: "kmv-ha",
      subnetIds: subnets,
      nodegroup: { subnetIds: ["subnet-nodes"], desiredSize: 2, minSize: 1, maxSize: 4 },
    }) as unknown as Members;
    const ng2 = c.nodegroup!.props!;
    expect(ng2.Subnets).toEqual(["subnet-nodes"]);
    expect(ng2.ScalingConfig.MinSize).toBe(1);
    expect(ng2.ScalingConfig.MaxSize).toBe(4);
  });

  test("defaults escape hatch reaches the cluster (e.g. deletion protection)", () => {
    const c = EksCluster({
      name: "kmv-guarded",
      subnetIds: subnets,
      defaults: { cluster: { DeletionProtection: true } },
    });
    expect((c.cluster as any).props.DeletionProtection).toBe(true);
  });

  test("addons become keyed members, DependsOn the cluster (the pod-identity agent case)", () => {
    const c = EksCluster({
      name: "kmv-real",
      subnetIds: subnets,
      nodegroup: {},
      addons: [{ name: "eks-pod-identity-agent" }],
    }) as unknown as Members;
    const addon = c.addon1;
    expect(addon).toBeDefined();
    expect(addon!.props?.AddonName).toBe("eks-pod-identity-agent");
    expect(addon!.props?.ClusterName).toBe("kmv-real");
  });
});
