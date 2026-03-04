import { describe, test, expect } from "bun:test";
import { describeExample } from "@intentius/chant-test-utils/example-harness";
import { build } from "@intentius/chant/build";
import { lintCommand } from "@intentius/chant/cli/commands/lint";
import { awsSerializer } from "@intentius/chant-lexicon-aws";
import { gcpSerializer } from "@intentius/chant-lexicon-gcp";
import { azureSerializer } from "@intentius/chant-lexicon-azure";
import { k8sSerializer } from "@intentius/chant-lexicon-k8s";
import { gitlabSerializer } from "@intentius/chant-lexicon-gitlab";
import { flywaySerializer } from "@intentius/chant-lexicon-flyway";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { k8sPlugin } from "@intentius/chant-lexicon-k8s/plugin";
import { resolve } from "path";

// ── Helpers ──────────────────────────────────────────────────────────

/** Parse multi-doc YAML into an array of { kind, name, doc } objects. */
function parseK8sDocs(yaml: string) {
  return yaml
    .split("---")
    .filter((d) => d.trim())
    .map((doc) => {
      const kind = doc.match(/kind:\s+(\S+)/)?.[1] ?? "";
      const name = doc.match(/\s+name:\s+(\S+)/)?.[1] ?? "";
      return { kind, name, doc };
    });
}

// ── GitLab + AWS ALB examples ────────────────────────────────────────

describeExample("gitlab-aws-alb-infra", {
  lexicon: "gitlab-aws-alb",
  serializer: [awsSerializer, gitlabSerializer],
  outputKey: ["aws", "gitlab"],
  examplesDir: import.meta.dir,
});

describeExample("gitlab-aws-alb-api", {
  lexicon: "gitlab-aws-alb",
  serializer: [awsSerializer, gitlabSerializer],
  outputKey: ["aws", "gitlab"],
  examplesDir: import.meta.dir,
});

describeExample("gitlab-aws-alb-ui", {
  lexicon: "gitlab-aws-alb",
  serializer: [awsSerializer, gitlabSerializer],
  outputKey: ["aws", "gitlab"],
  examplesDir: import.meta.dir,
});

// ── Flyway + GitLab + AWS RDS ────────────────────────────────────────

describeExample("flyway-postgresql-gitlab-aws-rds", {
  lexicon: "flyway-gitlab-aws",
  serializer: [awsSerializer, flywaySerializer, gitlabSerializer],
  outputKey: ["aws", "flyway", "gitlab"],
  examplesDir: import.meta.dir,
});

// ── K8s + AWS EKS microservice (comprehensive) ──────────────────────

describe("k8s-eks-microservice example", () => {
  const srcDir = resolve(import.meta.dir, "k8s-eks-microservice", "src");

  test("passes lint", async () => {
    const result = await lintCommand({
      path: srcDir,
      format: "stylish",
      fix: true,
    });
    if (!result.success || result.errorCount > 0 || result.warningCount > 0) {
      console.log(result.output);
    }
    expect(result.success).toBe(true);
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
  });

  test("combined build succeeds with both serializers", async () => {
    const result = await build(srcDir, [awsSerializer, k8sSerializer]);
    expect(result.errors).toHaveLength(0);
    expect(result.outputs.has("aws")).toBe(true);
    expect(result.outputs.has("k8s")).toBe(true);
  });

  test("CloudFormation template contains all expected resources", async () => {
    const result = await build(srcDir, [awsSerializer]);
    expect(result.errors).toHaveLength(0);
    const parsed = JSON.parse(result.outputs.get("aws")!);
    expect(parsed.AWSTemplateFormatVersion).toBe("2010-09-09");
    // 17 VPC + 1 cluster + 1 nodegroup + 1 OIDC + 8 IAM roles + 1 IAM policy + 4 addons + 1 KMS key + 1 HostedZone = 35
    expect(Object.keys(parsed.Resources)).toHaveLength(35);
    const types = Object.values(parsed.Resources).map((r: any) => r.Type);
    expect(types).toContain("AWS::EKS::Cluster");
    expect(types).toContain("AWS::EKS::Nodegroup");
    expect(types).toContain("AWS::IAM::OIDCProvider");
    expect(types).toContain("AWS::EC2::VPC");
    expect(types.filter((t: string) => t === "AWS::IAM::Role")).toHaveLength(8);
    expect(types.filter((t: string) => t === "AWS::EKS::Addon")).toHaveLength(4);
    expect(types).toContain("AWS::KMS::Key");
    expect(types).toContain("AWS::Route53::HostedZone");
  });

  test("EKS cluster has correct properties", async () => {
    const result = await build(srcDir, [awsSerializer]);
    const parsed = JSON.parse(result.outputs.get("aws")!);
    const cluster = parsed.Resources.cluster;
    expect(cluster.Type).toBe("AWS::EKS::Cluster");
    expect(cluster.Properties.Name).toBe("eks-microservice");
    expect(cluster.Properties.Version).toBe("1.31");
    const vpcConfig = cluster.Properties.ResourcesVpcConfig;
    expect(vpcConfig.SubnetIds).toHaveLength(4);
    expect(vpcConfig.EndpointPublicAccess).toBe(true);
    expect(vpcConfig.EndpointPrivateAccess).toBe(true);
    const encryption = cluster.Properties.EncryptionConfig;
    expect(encryption).toHaveLength(1);
    expect(encryption[0].Resources).toEqual(["secrets"]);
  });

  test("managed node group has correct scaling and instance config", async () => {
    const result = await build(srcDir, [awsSerializer]);
    const parsed = JSON.parse(result.outputs.get("aws")!);
    const ng = parsed.Resources.nodegroup;
    expect(ng.Type).toBe("AWS::EKS::Nodegroup");
    expect(ng.Properties.InstanceTypes).toEqual(["t3.medium"]);
    expect(ng.Properties.AmiType).toBe("AL2023_x86_64_STANDARD");
    const scaling = ng.Properties.ScalingConfig;
    expect(scaling.MinSize).toBe(2);
    expect(scaling.MaxSize).toBe(6);
    expect(scaling.DesiredSize).toBe(3);
  });

  test("IAM roles have correct trust policies", async () => {
    const result = await build(srcDir, [awsSerializer]);
    const parsed = JSON.parse(result.outputs.get("aws")!);
    const clusterRolePolicy =
      parsed.Resources.clusterRole.Properties.AssumeRolePolicyDocument;
    expect(clusterRolePolicy.Statement.Principal.Service).toBe(
      "eks.amazonaws.com",
    );
    const nodeRolePolicy =
      parsed.Resources.nodeRole.Properties.AssumeRolePolicyDocument;
    expect(nodeRolePolicy.Statement.Principal.Service).toBe(
      "ec2.amazonaws.com",
    );
    const appRolePolicy =
      parsed.Resources.appRole.Properties.AssumeRolePolicyDocument;
    expect(appRolePolicy["Fn::Sub"]).toBeDefined();
    const [template] = appRolePolicy["Fn::Sub"];
    expect(template).toContain("sts:AssumeRoleWithWebIdentity");
    expect(template).toContain(
      "system:serviceaccount:microservice:microservice-app-sa",
    );
  });

  test("OIDC provider references cluster", async () => {
    const result = await build(srcDir, [awsSerializer]);
    const parsed = JSON.parse(result.outputs.get("aws")!);
    const oidc = parsed.Resources.oidcProvider;
    expect(oidc.Type).toBe("AWS::IAM::OIDCProvider");
    expect(oidc.Properties.ClientIdList).toEqual(["sts.amazonaws.com"]);
  });

  test("stack outputs expose all required ARNs and IDs", async () => {
    const result = await build(srcDir, [awsSerializer]);
    const parsed = JSON.parse(result.outputs.get("aws")!);
    const outputNames = Object.keys(parsed.Outputs);
    for (const name of [
      "vpcId",
      "publicSubnet1Id",
      "publicSubnet2Id",
      "privateSubnet1Id",
      "privateSubnet2Id",
      "clusterEndpoint",
      "clusterArnOutput",
      "appRoleArn",
      "albControllerRoleArn",
      "externalDnsRoleArn",
      "fluentBitRoleArn",
      "adotRoleArn",
      "hostedZoneIdOutput",
    ]) {
      expect(outputNames).toContain(name);
    }
    expect(outputNames).toHaveLength(13);
  });

  test("K8s output contains all expected resources", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    expect(result.errors).toHaveLength(0);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    expect(docs).toHaveLength(36);
    const kinds = docs.map((d) => d.kind);
    expect(kinds.filter((k) => k === "Deployment")).toHaveLength(3);
    expect(kinds.filter((k) => k === "Service")).toHaveLength(2);
    expect(kinds.filter((k) => k === "ServiceAccount")).toHaveLength(5);
    expect(kinds.filter((k) => k === "DaemonSet")).toHaveLength(2);
    expect(kinds.filter((k) => k === "Namespace")).toHaveLength(3);
  });

  test("IRSA ServiceAccount has role-arn annotation", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    const appSa = docs.find(
      (d) => d.kind === "ServiceAccount" && d.name === "microservice-app-sa",
    );
    expect(appSa).toBeDefined();
    expect(appSa!.doc).toContain("eks.amazonaws.com/role-arn");
  });

  test("ALB Ingress has correct annotations", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    const ingress = docs.find((d) => d.kind === "Ingress");
    expect(ingress).toBeDefined();
    expect(ingress!.doc).toContain(
      "alb.ingress.kubernetes.io/scheme: internet-facing",
    );
    expect(ingress!.doc).toContain(
      "alb.ingress.kubernetes.io/target-type: ip",
    );
    expect(ingress!.doc).toContain("ingressClassName: alb");
  });

  test("app resources are in the microservice namespace", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    for (const name of [
      "microservice-api",
      "microservice-app-sa",
      "microservice-alb",
    ]) {
      const doc = docs.find((d) => d.name === name);
      expect(doc).toBeDefined();
      expect(doc!.doc).toContain("namespace: microservice");
    }
  });

  test("all resources have managed-by: chant label", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    for (const doc of docs) {
      expect(doc.doc).toContain("app.kubernetes.io/managed-by: chant");
    }
  });

  test("generated K8s YAML passes all post-synth error-level checks", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    expect(result.errors).toHaveLength(0);
    const ctx: PostSynthContext = {
      outputs: result.outputs,
      entities: result.entities,
      buildResult: {
        outputs: result.outputs,
        entities: result.entities,
        warnings: result.warnings ?? [],
        errors: result.errors,
        sourceFileCount: 1,
      },
    };
    const allChecks = k8sPlugin.postSynthChecks!();
    const allDiags = allChecks.flatMap((c) => c.check(ctx));
    const errors = allDiags.filter((d) => d.severity === "error");
    if (errors.length > 0) {
      console.log(
        "Post-synth errors:",
        errors.map((e) => `${e.checkId}: ${e.message}`),
      );
    }
    expect(errors).toEqual([]);
  });
});

// ── K8s + GCP GKE microservice (comprehensive) ──────────────────────

describe("k8s-gke-microservice example", () => {
  const srcDir = resolve(import.meta.dir, "k8s-gke-microservice", "src");

  test("passes lint", async () => {
    const result = await lintCommand({
      path: srcDir,
      format: "stylish",
      fix: true,
    });
    if (!result.success || result.errorCount > 0 || result.warningCount > 0) {
      console.log(result.output);
    }
    expect(result.success).toBe(true);
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
  });

  test("combined build succeeds with both serializers", async () => {
    const result = await build(srcDir, [gcpSerializer, k8sSerializer]);
    expect(result.errors).toHaveLength(0);
    expect(result.outputs.has("gcp")).toBe(true);
    expect(result.outputs.has("k8s")).toBe(true);
  });

  test("GCP Config Connector output contains all expected resources", async () => {
    const result = await build(srcDir, [gcpSerializer]);
    expect(result.errors).toHaveLength(0);
    const docs = result.outputs.get("gcp")!.split("---").filter((d) => d.trim());
    // 4 SAs + 8 IAM bindings + DNS zone = 13
    // (VPC/cluster composites return plain objects — not yet generated as Declarables)
    expect(docs.length).toBeGreaterThanOrEqual(13);
    const kinds = docs.map((d) => d.match(/kind:\s+(\S+)/)?.[1] ?? "");
    expect(kinds.filter((k) => k === "IAMServiceAccount").length).toBeGreaterThanOrEqual(4);
    expect(kinds.filter((k) => k === "IAMPolicyMember").length).toBeGreaterThanOrEqual(8);
    expect(kinds).toContain("DNSManagedZone");
  });

  test("IAM bindings reference correct SA emails", async () => {
    const result = await build(srcDir, [gcpSerializer]);
    const output = result.outputs.get("gcp")!;
    expect(output).toContain("gke-microservice-app");
    expect(output).toContain("gke-microservice-dns");
    expect(output).toContain("gke-microservice-logging");
    expect(output).toContain("gke-microservice-monitoring");
    expect(output).toContain("roles/iam.workloadIdentityUser");
    expect(output).toContain("roles/dns.admin");
    expect(output).toContain("roles/logging.logWriter");
    expect(output).toContain("roles/monitoring.metricWriter");
    expect(output).toContain("roles/cloudtrace.agent");
  });

  test("K8s output contains all expected resources", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    expect(result.errors).toHaveLength(0);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    expect(docs.length).toBeGreaterThanOrEqual(28);
    const kinds = docs.map((d) => d.kind);
    expect(kinds.filter((k) => k === "Deployment")).toHaveLength(2);
    expect(kinds.filter((k) => k === "Service")).toHaveLength(1);
    expect(kinds.filter((k) => k === "ServiceAccount")).toHaveLength(4);
    expect(kinds.filter((k) => k === "DaemonSet")).toHaveLength(2);
    expect(kinds.filter((k) => k === "Namespace")).toHaveLength(3);
    expect(kinds.filter((k) => k === "Ingress")).toHaveLength(1);
  });

  test("Workload Identity SA has iam.gke.io/gcp-service-account annotation", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    const appSa = docs.find(
      (d) => d.kind === "ServiceAccount" && d.name === "microservice-app-sa",
    );
    expect(appSa).toBeDefined();
    expect(appSa!.doc).toContain("iam.gke.io/gcp-service-account");
  });

  test("GCE Ingress has correct annotations", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    const ingress = docs.find((d) => d.kind === "Ingress");
    expect(ingress).toBeDefined();
    expect(ingress!.doc).toContain("kubernetes.io/ingress.class: gce");
  });

  test("app resources are in the microservice namespace", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    for (const name of [
      "microservice-api",
      "microservice-app-sa",
      "microservice-ingress",
    ]) {
      const doc = docs.find((d) => d.name === name);
      expect(doc).toBeDefined();
      expect(doc!.doc).toContain("namespace: microservice");
    }
  });

  test("all resources have managed-by: chant label", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    for (const doc of docs) {
      expect(doc.doc).toContain("app.kubernetes.io/managed-by: chant");
    }
  });

  test("generated K8s YAML passes all post-synth error-level checks", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    expect(result.errors).toHaveLength(0);
    const ctx: PostSynthContext = {
      outputs: result.outputs,
      entities: result.entities,
      buildResult: {
        outputs: result.outputs,
        entities: result.entities,
        warnings: result.warnings ?? [],
        errors: result.errors,
        sourceFileCount: 1,
      },
    };
    const allChecks = k8sPlugin.postSynthChecks!();
    const allDiags = allChecks.flatMap((c) => c.check(ctx));
    const errors = allDiags.filter((d) => d.severity === "error");
    if (errors.length > 0) {
      console.log(
        "Post-synth errors:",
        errors.map((e) => `${e.checkId}: ${e.message}`),
      );
    }
    expect(errors).toEqual([]);
  });
});

// ── K8s + Azure AKS microservice (comprehensive) ────────────────────

describe("k8s-aks-microservice example", () => {
  const srcDir = resolve(import.meta.dir, "k8s-aks-microservice", "src");

  test("passes lint", async () => {
    const result = await lintCommand({
      path: srcDir,
      format: "stylish",
      fix: true,
    });
    if (!result.success || result.errorCount > 0 || result.warningCount > 0) {
      console.log(result.output);
    }
    expect(result.success).toBe(true);
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
  });

  test("combined build succeeds with both serializers", async () => {
    const result = await build(srcDir, [azureSerializer, k8sSerializer]);
    expect(result.errors).toHaveLength(0);
    expect(result.outputs.has("azure")).toBe(true);
    expect(result.outputs.has("k8s")).toBe(true);
  });

  test("ARM template contains all expected resources", async () => {
    const result = await build(srcDir, [azureSerializer]);
    expect(result.errors).toHaveLength(0);
    const parsed = JSON.parse(result.outputs.get("azure")!);
    expect(parsed.$schema).toContain("deploymentTemplate.json");
    const types = parsed.resources.map((r: any) => r.type);
    expect(types).toContain("Microsoft.ContainerService/managedClusters");
    expect(types).toContain("Microsoft.ContainerRegistry/registries");
    expect(types).toContain("Microsoft.Network/virtualNetworks");
    expect(types.filter((t: string) => t === "Microsoft.ManagedIdentity/userAssignedIdentities")).toHaveLength(3);
    expect(types.filter((t: string) => t === "Microsoft.Authorization/roleAssignments")).toHaveLength(3);
    expect(types).toContain("Microsoft.Network/dnsZones");
  });

  test("AKS cluster has correct properties", async () => {
    const result = await build(srcDir, [azureSerializer]);
    const parsed = JSON.parse(result.outputs.get("azure")!);
    const cluster = parsed.resources.find(
      (r: any) => r.type === "Microsoft.ContainerService/managedClusters",
    );
    expect(cluster).toBeDefined();
    expect(cluster.name).toBe("aks-microservice");
    expect(cluster.properties.kubernetesVersion).toBe("1.32");
    expect(cluster.properties.agentPoolProfiles[0].count).toBe(3);
    expect(cluster.properties.agentPoolProfiles[0].vmSize).toBe("Standard_B2s");
    expect(cluster.properties.enableRBAC).toBe(true);
  });

  test("K8s output contains all expected resources", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    expect(result.errors).toHaveLength(0);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    expect(docs.length).toBeGreaterThanOrEqual(22);
    const kinds = docs.map((d) => d.kind);
    expect(kinds.filter((k) => k === "Deployment")).toHaveLength(2);
    expect(kinds.filter((k) => k === "Service")).toHaveLength(1);
    expect(kinds.filter((k) => k === "ServiceAccount")).toHaveLength(3);
    expect(kinds.filter((k) => k === "DaemonSet")).toHaveLength(1);
    expect(kinds.filter((k) => k === "Namespace")).toHaveLength(2);
  });

  test("Workload Identity SA has azure.workload.identity/client-id annotation", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    const appSa = docs.find(
      (d) => d.kind === "ServiceAccount" && d.name === "microservice-app-sa",
    );
    expect(appSa).toBeDefined();
    expect(appSa!.doc).toContain("azure.workload.identity/client-id");
  });

  test("AGIC Ingress has correct annotations", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    const ingress = docs.find((d) => d.kind === "Ingress");
    expect(ingress).toBeDefined();
    expect(ingress!.doc).toContain("kubernetes.io/ingress.class: azure/application-gateway");
  });

  test("app resources are in the microservice namespace", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    for (const name of [
      "microservice-api",
      "microservice-app-sa",
      "microservice-agic",
    ]) {
      const doc = docs.find((d) => d.name === name);
      expect(doc).toBeDefined();
      expect(doc!.doc).toContain("namespace: microservice");
    }
  });

  test("all resources have managed-by: chant label", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    for (const doc of docs) {
      expect(doc.doc).toContain("app.kubernetes.io/managed-by: chant");
    }
  });

  test("generated K8s YAML passes all post-synth error-level checks", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    expect(result.errors).toHaveLength(0);
    const ctx: PostSynthContext = {
      outputs: result.outputs,
      entities: result.entities,
      buildResult: {
        outputs: result.outputs,
        entities: result.entities,
        warnings: result.warnings ?? [],
        errors: result.errors,
        sourceFileCount: 1,
      },
    };
    const allChecks = k8sPlugin.postSynthChecks!();
    const allDiags = allChecks.flatMap((c) => c.check(ctx));
    const errors = allDiags.filter((d) => d.severity === "error");
    if (errors.length > 0) {
      console.log(
        "Post-synth errors:",
        errors.map((e) => `${e.checkId}: ${e.message}`),
      );
    }
    expect(errors).toEqual([]);
  });
});

// ── CockroachDB Multi-Cloud (EKS + AKS + GKE) ──────────────────────

describe("cockroachdb-multi-cloud EKS stack", () => {
  const srcDir = resolve(import.meta.dir, "cockroachdb-multi-cloud", "src", "eks");

  test("EKS passes lint", async () => {
    const result = await lintCommand({ path: srcDir, format: "stylish", fix: true });
    if (!result.success || result.errorCount > 0 || result.warningCount > 0) {
      console.log(result.output);
    }
    expect(result.success).toBe(true);
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
  });

  test("EKS combined build succeeds with both serializers", async () => {
    const result = await build(srcDir, [awsSerializer, k8sSerializer]);
    expect(result.errors).toHaveLength(0);
    expect(result.outputs.has("aws")).toBe(true);
    expect(result.outputs.has("k8s")).toBe(true);
  });

  test("EKS CloudFormation template has expected resource types", async () => {
    const result = await build(srcDir, [awsSerializer]);
    expect(result.errors).toHaveLength(0);
    const parsed = JSON.parse(result.outputs.get("aws")!);
    const types = Object.values(parsed.Resources).map((r: any) => r.Type);
    expect(types).toContain("AWS::EKS::Cluster");
    expect(types).toContain("AWS::EKS::Nodegroup");
    expect(types).toContain("AWS::EC2::VPNGateway");
    expect(types).toContain("AWS::EC2::VPNConnection");
    expect(types).toContain("AWS::Route53::HostedZone");
  });

  test("EKS K8s output has CockroachDB resources", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    expect(result.errors).toHaveLength(0);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    const kinds = docs.map((d) => d.kind);
    expect(kinds).toContain("StatefulSet");
    expect(kinds.filter((k) => k === "Service")).toHaveLength(2);
    expect(kinds).toContain("ServiceAccount");
    expect(kinds).toContain("PodDisruptionBudget");
    expect(kinds).toContain("Role");
    expect(kinds).toContain("ClusterRole");
    expect(kinds.filter((k) => k === "Job")).toHaveLength(2);
    expect(kinds).toContain("Namespace");
    expect(kinds).toContain("StorageClass");
    expect(kinds).toContain("Ingress");
    expect(kinds).toContain("NetworkPolicy");
    expect(kinds).toContain("ConfigMap");
  });

  test("EKS StatefulSet has correct config", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    const sts = docs.find((d) => d.kind === "StatefulSet");
    expect(sts).toBeDefined();
    expect(sts!.doc).toContain("replicas: 3");
    expect(sts!.doc).toContain("containerPort: 26257");
    expect(sts!.doc).toContain("containerPort: 8080");
    expect(sts!.doc).toContain("storage:");
    expect(sts!.doc).toContain("100Gi");
  });

  test("EKS join addresses reference all 3 clouds", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    const sts = docs.find((d) => d.kind === "StatefulSet");
    expect(sts).toBeDefined();
    expect(sts!.doc).toContain("crdb-eks.svc.cluster.local");
    expect(sts!.doc).toContain("crdb-aks.svc.cluster.local");
    expect(sts!.doc).toContain("crdb-gke.svc.cluster.local");
  });

  test("EKS resources are in crdb-eks namespace", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    const sts = docs.find((d) => d.kind === "StatefulSet");
    expect(sts).toBeDefined();
    expect(sts!.doc).toContain("namespace: crdb-eks");
  });

  test("EKS all resources have managed-by: chant label", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    for (const doc of docs) {
      expect(doc.doc).toContain("app.kubernetes.io/managed-by: chant");
    }
  });
});

describe("cockroachdb-multi-cloud AKS stack", () => {
  const srcDir = resolve(import.meta.dir, "cockroachdb-multi-cloud", "src", "aks");

  test("AKS passes lint", async () => {
    const result = await lintCommand({ path: srcDir, format: "stylish", fix: true });
    if (!result.success || result.errorCount > 0 || result.warningCount > 0) {
      console.log(result.output);
    }
    expect(result.success).toBe(true);
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
  });

  test("AKS combined build succeeds with both serializers", async () => {
    const result = await build(srcDir, [azureSerializer, k8sSerializer]);
    expect(result.errors).toHaveLength(0);
    expect(result.outputs.has("azure")).toBe(true);
    expect(result.outputs.has("k8s")).toBe(true);
  });

  test("AKS ARM template has expected resource types", async () => {
    const result = await build(srcDir, [azureSerializer]);
    expect(result.errors).toHaveLength(0);
    const parsed = JSON.parse(result.outputs.get("azure")!);
    const types = parsed.resources.map((r: any) => r.type);
    expect(types).toContain("Microsoft.ContainerService/managedClusters");
    expect(types).toContain("Microsoft.Network/virtualNetworks");
    expect(types).toContain("Microsoft.Network/virtualNetworkGateways");
    expect(types).toContain("Microsoft.Network/connections");
    expect(types).toContain("Microsoft.Network/dnsZones");
  });

  test("AKS K8s output has CockroachDB resources", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    expect(result.errors).toHaveLength(0);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    const kinds = docs.map((d) => d.kind);
    expect(kinds).toContain("StatefulSet");
    expect(kinds.filter((k) => k === "Service").length).toBeGreaterThanOrEqual(2);
    expect(kinds).toContain("PodDisruptionBudget");
    expect(kinds.filter((k) => k === "Job").length).toBeGreaterThanOrEqual(2);
    expect(kinds).toContain("Namespace");
    expect(kinds).toContain("StorageClass");
    expect(kinds).toContain("Ingress");
    expect(kinds).toContain("NetworkPolicy");
    expect(kinds).toContain("ConfigMap");
  });

  test("AKS all resources have managed-by: chant label", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    for (const doc of docs) {
      expect(doc.doc).toContain("app.kubernetes.io/managed-by: chant");
    }
  });

  test("AKS join addresses reference all 3 clouds", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    const sts = docs.find((d) => d.kind === "StatefulSet");
    expect(sts).toBeDefined();
    expect(sts!.doc).toContain("crdb-eks.svc.cluster.local");
    expect(sts!.doc).toContain("crdb-aks.svc.cluster.local");
    expect(sts!.doc).toContain("crdb-gke.svc.cluster.local");
  });

  test("AKS resources are in crdb-aks namespace", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    const sts = docs.find((d) => d.kind === "StatefulSet");
    expect(sts).toBeDefined();
    expect(sts!.doc).toContain("namespace: crdb-aks");
  });
});

describe("cockroachdb-multi-cloud GKE stack", () => {
  const srcDir = resolve(import.meta.dir, "cockroachdb-multi-cloud", "src", "gke");

  test("GKE passes lint", async () => {
    const result = await lintCommand({ path: srcDir, format: "stylish", fix: true });
    if (!result.success || result.errorCount > 0 || result.warningCount > 0) {
      console.log(result.output);
    }
    expect(result.success).toBe(true);
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
  });

  test("GKE combined build succeeds with both serializers", async () => {
    const result = await build(srcDir, [gcpSerializer, k8sSerializer]);
    expect(result.errors).toHaveLength(0);
    expect(result.outputs.has("gcp")).toBe(true);
    expect(result.outputs.has("k8s")).toBe(true);
  });

  test("GKE Config Connector output has expected resources", async () => {
    const result = await build(srcDir, [gcpSerializer]);
    expect(result.errors).toHaveLength(0);
    const output = result.outputs.get("gcp")!;
    expect(output).toContain("DNSManagedZone");
    expect(output).toContain("gke-cockroachdb-dns");
    expect(output).toContain("roles/dns.admin");
  });

  test("GKE K8s output has CockroachDB resources", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    expect(result.errors).toHaveLength(0);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    const kinds = docs.map((d) => d.kind);
    expect(kinds).toContain("StatefulSet");
    expect(kinds.filter((k) => k === "Service").length).toBeGreaterThanOrEqual(2);
    expect(kinds).toContain("PodDisruptionBudget");
    expect(kinds.filter((k) => k === "Job").length).toBeGreaterThanOrEqual(2);
    expect(kinds).toContain("Namespace");
    expect(kinds).toContain("StorageClass");
    expect(kinds).toContain("Ingress");
    expect(kinds).toContain("NetworkPolicy");
    expect(kinds).toContain("ConfigMap");
  });

  test("GKE all resources have managed-by: chant label", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    for (const doc of docs) {
      expect(doc.doc).toContain("app.kubernetes.io/managed-by: chant");
    }
  });

  test("GKE join addresses reference all 3 clouds", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    const sts = docs.find((d) => d.kind === "StatefulSet");
    expect(sts).toBeDefined();
    expect(sts!.doc).toContain("crdb-eks.svc.cluster.local");
    expect(sts!.doc).toContain("crdb-aks.svc.cluster.local");
    expect(sts!.doc).toContain("crdb-gke.svc.cluster.local");
  });

  test("GKE resources are in crdb-gke namespace", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    const sts = docs.find((d) => d.kind === "StatefulSet");
    expect(sts).toBeDefined();
    expect(sts!.doc).toContain("namespace: crdb-gke");
  });
});
