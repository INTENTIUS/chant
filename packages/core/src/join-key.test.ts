import { describe, expect, test } from "vitest";
import { joinKey, joinLabel } from "./join-key";

describe("joinKey (#2539, ws-008)", () => {
  test("folds case and punctuation", () => {
    for (const name of ["ClusterArn", "clusterArn", "cluster_arn", "cluster-arn", "CLUSTER.ARN", "Cluster Arn"]) {
      expect(joinKey(name)).toBe("clusterarn");
    }
  });

  test("keeps digits and letters outside ASCII", () => {
    expect(joinKey("Subnet1")).toBe("subnet1");
    expect(joinKey("Subnet1")).not.toBe(joinKey("Subnet2"));
    expect(joinKey("Größe")).toBe("größe");
  });

  test("labels a join exact or folded, and says when names don't join", () => {
    expect(joinLabel("ClusterArn", "ClusterArn")).toBe("exact");
    expect(joinLabel("clusterArn", "ClusterArn")).toBe("folded");
    expect(joinLabel("vpc_id", "VpcId")).toBe("folded");
    expect(joinLabel("VpcId", "SubnetId")).toBeUndefined();
    expect(joinLabel("", "")).toBeUndefined();
    expect(joinLabel("--", "__")).toBeUndefined();
  });
});
