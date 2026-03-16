import { describe, test, expect } from "bun:test";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw031, checkAddonMissingRole } from "./waw031";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

describe("WAW031: EKS Addon Missing ServiceAccountRoleArn", () => {
  test("check metadata", () => {
    expect(waw031.id).toBe("WAW031");
    expect(waw031.description).toContain("ServiceAccountRoleArn");
  });

  // --- aws-ebs-csi-driver ---

  test("EBS CSI addon without ServiceAccountRoleArn → warning", () => {
    const ctx = makeCtx({
      Resources: {
        EbsCsi: {
          Type: "AWS::EKS::Addon",
          Properties: {
            AddonName: "aws-ebs-csi-driver",
            ClusterName: "my-cluster",
          },
        },
      },
    });
    const diags = checkAddonMissingRole(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW031");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("EbsCsi");
    expect(diags[0].message).toContain("aws-ebs-csi-driver");
    expect(diags[0].message).toContain("IRSA");
    expect(diags[0].entity).toBe("EbsCsi");
    expect(diags[0].lexicon).toBe("aws");
  });

  test("EBS CSI addon with ServiceAccountRoleArn string → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        EbsCsi: {
          Type: "AWS::EKS::Addon",
          Properties: {
            AddonName: "aws-ebs-csi-driver",
            ClusterName: "my-cluster",
            ServiceAccountRoleArn: "arn:aws:iam::123456789012:role/ebs-csi-role",
          },
        },
      },
    });
    const diags = checkAddonMissingRole(ctx);
    expect(diags).toHaveLength(0);
  });

  test("EBS CSI addon with ServiceAccountRoleArn via GetAtt → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        EbsCsi: {
          Type: "AWS::EKS::Addon",
          Properties: {
            AddonName: "aws-ebs-csi-driver",
            ClusterName: "my-cluster",
            ServiceAccountRoleArn: { "Fn::GetAtt": ["EbsCsiRole", "Arn"] },
          },
        },
      },
    });
    const diags = checkAddonMissingRole(ctx);
    expect(diags).toHaveLength(0);
  });

  // --- aws-efs-csi-driver ---

  test("EFS CSI addon without ServiceAccountRoleArn → warning", () => {
    const ctx = makeCtx({
      Resources: {
        EfsCsi: {
          Type: "AWS::EKS::Addon",
          Properties: {
            AddonName: "aws-efs-csi-driver",
            ClusterName: "my-cluster",
          },
        },
      },
    });
    const diags = checkAddonMissingRole(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("aws-efs-csi-driver");
    expect(diags[0].entity).toBe("EfsCsi");
  });

  // --- adot ---

  test("ADOT addon without ServiceAccountRoleArn → warning", () => {
    const ctx = makeCtx({
      Resources: {
        Adot: {
          Type: "AWS::EKS::Addon",
          Properties: {
            AddonName: "adot",
            ClusterName: "my-cluster",
          },
        },
      },
    });
    const diags = checkAddonMissingRole(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("adot");
    expect(diags[0].entity).toBe("Adot");
  });

  test("ADOT addon with ServiceAccountRoleArn → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        Adot: {
          Type: "AWS::EKS::Addon",
          Properties: {
            AddonName: "adot",
            ClusterName: "my-cluster",
            ServiceAccountRoleArn: "arn:aws:iam::123456789012:role/adot-role",
          },
        },
      },
    });
    const diags = checkAddonMissingRole(ctx);
    expect(diags).toHaveLength(0);
  });

  // --- amazon-cloudwatch-observability ---

  test("CloudWatch observability addon without ServiceAccountRoleArn → warning", () => {
    const ctx = makeCtx({
      Resources: {
        CwObs: {
          Type: "AWS::EKS::Addon",
          Properties: {
            AddonName: "amazon-cloudwatch-observability",
            ClusterName: "my-cluster",
          },
        },
      },
    });
    const diags = checkAddonMissingRole(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("amazon-cloudwatch-observability");
    expect(diags[0].entity).toBe("CwObs");
  });

  test("CloudWatch observability addon with ServiceAccountRoleArn → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        CwObs: {
          Type: "AWS::EKS::Addon",
          Properties: {
            AddonName: "amazon-cloudwatch-observability",
            ClusterName: "my-cluster",
            ServiceAccountRoleArn: { "Fn::GetAtt": ["CwObsRole", "Arn"] },
          },
        },
      },
    });
    const diags = checkAddonMissingRole(ctx);
    expect(diags).toHaveLength(0);
  });

  // --- Addons that don't require IRSA ---

  test("vpc-cni addon without ServiceAccountRoleArn → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        VpcCni: {
          Type: "AWS::EKS::Addon",
          Properties: {
            AddonName: "vpc-cni",
            ClusterName: "my-cluster",
          },
        },
      },
    });
    const diags = checkAddonMissingRole(ctx);
    expect(diags).toHaveLength(0);
  });

  test("coredns addon without ServiceAccountRoleArn → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        CoreDns: {
          Type: "AWS::EKS::Addon",
          Properties: {
            AddonName: "coredns",
            ClusterName: "my-cluster",
          },
        },
      },
    });
    const diags = checkAddonMissingRole(ctx);
    expect(diags).toHaveLength(0);
  });

  test("kube-proxy addon without ServiceAccountRoleArn → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        KubeProxy: {
          Type: "AWS::EKS::Addon",
          Properties: {
            AddonName: "kube-proxy",
            ClusterName: "my-cluster",
          },
        },
      },
    });
    const diags = checkAddonMissingRole(ctx);
    expect(diags).toHaveLength(0);
  });

  // --- Edge cases ---

  test("multiple addons — only flags those requiring IRSA", () => {
    const ctx = makeCtx({
      Resources: {
        VpcCni: {
          Type: "AWS::EKS::Addon",
          Properties: { AddonName: "vpc-cni", ClusterName: "c" },
        },
        EbsCsi: {
          Type: "AWS::EKS::Addon",
          Properties: { AddonName: "aws-ebs-csi-driver", ClusterName: "c" },
        },
        CoreDns: {
          Type: "AWS::EKS::Addon",
          Properties: { AddonName: "coredns", ClusterName: "c" },
        },
      },
    });
    const diags = checkAddonMissingRole(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].entity).toBe("EbsCsi");
  });

  test("addon without AddonName property → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        Mystery: {
          Type: "AWS::EKS::Addon",
          Properties: { ClusterName: "c" },
        },
      },
    });
    const diags = checkAddonMissingRole(ctx);
    expect(diags).toHaveLength(0);
  });

  test("non-addon resource → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        MyCluster: {
          Type: "AWS::EKS::Cluster",
          Properties: { Name: "my-cluster" },
        },
      },
    });
    const diags = checkAddonMissingRole(ctx);
    expect(diags).toHaveLength(0);
  });

  test("empty Resources → no diagnostic", () => {
    const ctx = makeCtx({ Resources: {} });
    const diags = checkAddonMissingRole(ctx);
    expect(diags).toHaveLength(0);
  });
});
