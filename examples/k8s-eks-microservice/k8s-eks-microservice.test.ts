import { describe, test, expect } from "bun:test";
import { lintCommand } from "../../packages/core/src/cli/commands/lint";
import { build } from "../../packages/core/src/build";
import { resolve } from "path";
import { awsSerializer } from "../../lexicons/aws/src/serializer";
import { k8sSerializer } from "../../lexicons/k8s/src/serializer";

const srcDir = resolve(import.meta.dir, "src");

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

describe("k8s-eks-microservice example", () => {
  // ── Lint ────────────────────────────────────────────────────────

  test("passes strict lint", async () => {
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

  // ── Combined build ─────────────────────────────────────────────

  test("combined build succeeds with both serializers", async () => {
    const result = await build(srcDir, [awsSerializer, k8sSerializer]);

    expect(result.errors).toHaveLength(0);
    expect(result.outputs.has("aws")).toBe(true);
    expect(result.outputs.has("k8s")).toBe(true);
  });

  // ── CloudFormation: resource inventory ─────────────────────────

  test("CloudFormation template contains all expected resources", async () => {
    const result = await build(srcDir, [awsSerializer]);
    expect(result.errors).toHaveLength(0);

    const parsed = JSON.parse(result.outputs.get("aws")!);
    expect(parsed.AWSTemplateFormatVersion).toBe("2010-09-09");

    // 17 VPC + 1 cluster + 1 nodegroup + 1 OIDC + 7 IAM roles + 5 addons + 1 KMS key = 33
    expect(Object.keys(parsed.Resources)).toHaveLength(33);

    const types = Object.values(parsed.Resources).map((r: any) => r.Type);
    expect(types).toContain("AWS::EKS::Cluster");
    expect(types).toContain("AWS::EKS::Nodegroup");
    expect(types).toContain("AWS::IAM::OIDCProvider");
    expect(types).toContain("AWS::EC2::VPC");
    expect(types).toContain("AWS::EC2::Subnet");
    expect(types).toContain("AWS::EC2::NatGateway");
    expect(types.filter((t: string) => t === "AWS::IAM::Role")).toHaveLength(7);
    expect(types.filter((t: string) => t === "AWS::EKS::Addon")).toHaveLength(5);
    expect(types).toContain("AWS::KMS::Key");
  });

  // ── CloudFormation: EKS cluster properties ─────────────────────

  test("EKS cluster has correct properties", async () => {
    const result = await build(srcDir, [awsSerializer]);
    const parsed = JSON.parse(result.outputs.get("aws")!);

    const cluster = parsed.Resources.cluster;
    expect(cluster.Type).toBe("AWS::EKS::Cluster");
    expect(cluster.Properties.Name).toBe("eks-microservice");
    expect(cluster.Properties.Version).toBe("1.31");

    // VPC config references subnets
    const vpcConfig = cluster.Properties.ResourcesVpcConfig;
    expect(vpcConfig.SubnetIds).toHaveLength(4);
    expect(vpcConfig.EndpointPublicAccess).toBe(true);
    expect(vpcConfig.EndpointPrivateAccess).toBe(true);
    expect(vpcConfig.PublicAccessCidrs).toBeDefined();

    // KMS envelope encryption for secrets
    const encryption = cluster.Properties.EncryptionConfig;
    expect(encryption).toBeDefined();
    expect(encryption).toHaveLength(1);
    expect(encryption[0].Resources).toEqual(["secrets"]);
    expect(encryption[0].Provider.KeyArn).toBeDefined();

    // Control plane logging — all 5 types enabled
    const logging = cluster.Properties.Logging;
    expect(logging).toBeDefined();
    const logTypes = logging.ClusterLogging.EnabledTypes.map((e: any) => e.Type);
    expect(logTypes).toEqual(["api", "audit", "authenticator", "controllerManager", "scheduler"]);
  });

  // ── CloudFormation: Node group properties ──────────────────────

  test("managed node group has correct scaling and instance config", async () => {
    const result = await build(srcDir, [awsSerializer]);
    const parsed = JSON.parse(result.outputs.get("aws")!);

    const ng = parsed.Resources.nodegroup;
    expect(ng.Type).toBe("AWS::EKS::Nodegroup");
    expect(ng.Properties.ClusterName).toBe("eks-microservice");
    expect(ng.Properties.InstanceTypes).toEqual(["t3.medium"]);
    expect(ng.Properties.AmiType).toBe("AL2023_x86_64_STANDARD");

    // Scaling
    const scaling = ng.Properties.ScalingConfig;
    expect(scaling.MinSize).toBe(2);
    expect(scaling.MaxSize).toBe(6);
    expect(scaling.DesiredSize).toBe(3);

    // Nodes go into private subnets only
    expect(ng.Properties.Subnets).toHaveLength(2);
  });

  // ── CloudFormation: IAM roles ──────────────────────────────────

  test("IAM roles have correct trust policies", async () => {
    const result = await build(srcDir, [awsSerializer]);
    const parsed = JSON.parse(result.outputs.get("aws")!);

    // Cluster role trusts eks.amazonaws.com
    const clusterRolePolicy = parsed.Resources.clusterRole.Properties.AssumeRolePolicyDocument;
    expect(clusterRolePolicy.Statement.Principal.Service).toBe("eks.amazonaws.com");

    // Node role trusts ec2.amazonaws.com
    const nodeRolePolicy = parsed.Resources.nodeRole.Properties.AssumeRolePolicyDocument;
    expect(nodeRolePolicy.Statement.Principal.Service).toBe("ec2.amazonaws.com");

    // IRSA roles use Fn::Sub trust policy with OIDC condition blocks
    const appRolePolicy = parsed.Resources.appRole.Properties.AssumeRolePolicyDocument;
    expect(appRolePolicy["Fn::Sub"]).toBeDefined();
    const [template] = appRolePolicy["Fn::Sub"];
    expect(template).toContain("sts:AssumeRoleWithWebIdentity");
    expect(template).toContain("system:serviceaccount:microservice:microservice-app-sa");
    expect(template).toContain("sts.amazonaws.com");
  });

  // ── CloudFormation: OIDC provider links to cluster ─────────────

  test("OIDC provider references cluster issuer URL", async () => {
    const result = await build(srcDir, [awsSerializer]);
    const parsed = JSON.parse(result.outputs.get("aws")!);

    const oidc = parsed.Resources.oidcProvider;
    expect(oidc.Type).toBe("AWS::IAM::OIDCProvider");
    expect(oidc.Properties.ClientIdList).toEqual(["sts.amazonaws.com"]);
    // URL should reference the cluster's OIDC issuer (via GetAtt)
    expect(oidc.Properties.Url).toBeDefined();
  });

  // ── CloudFormation: stack outputs ──────────────────────────────

  test("stack outputs expose all required ARNs and IDs", async () => {
    const result = await build(srcDir, [awsSerializer]);
    const parsed = JSON.parse(result.outputs.get("aws")!);

    const outputNames = Object.keys(parsed.Outputs);
    // Infrastructure
    expect(outputNames).toContain("vpcId");
    expect(outputNames).toContain("publicSubnet1Id");
    expect(outputNames).toContain("publicSubnet2Id");
    expect(outputNames).toContain("privateSubnet1Id");
    expect(outputNames).toContain("privateSubnet2Id");
    // Cluster
    expect(outputNames).toContain("clusterEndpoint");
    expect(outputNames).toContain("clusterArnOutput");
    // IRSA role ARNs
    expect(outputNames).toContain("appRoleArn");
    expect(outputNames).toContain("albControllerRoleArn");
    expect(outputNames).toContain("externalDnsRoleArn");
    expect(outputNames).toContain("fluentBitRoleArn");
    expect(outputNames).toContain("adotRoleArn");

    expect(outputNames).toHaveLength(12);
  });

  // ── CloudFormation: EKS add-ons ────────────────────────────────

  test("all five EKS add-ons reference the cluster", async () => {
    const result = await build(srcDir, [awsSerializer]);
    const parsed = JSON.parse(result.outputs.get("aws")!);

    const addonNames = ["vpcCni", "ebsCsi", "coreDns", "kubeProxy", "albController"];
    for (const name of addonNames) {
      const addon = parsed.Resources[name];
      expect(addon.Type).toBe("AWS::EKS::Addon");
      expect(addon.Properties.ClusterName).toBe("eks-microservice");
      expect(addon.Properties.ResolveConflicts).toBe("OVERWRITE");
    }

    // ALB controller addon has ServiceAccountRoleArn
    const albAddon = parsed.Resources.albController;
    expect(albAddon.Properties.AddonName).toBe("aws-load-balancer-controller");
    expect(albAddon.Properties.ServiceAccountRoleArn).toBeDefined();
  });

  // ── K8s: resource inventory ────────────────────────────────────

  test("K8s output contains all 36 expected resources", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    expect(result.errors).toHaveLength(0);

    const docs = parseK8sDocs(result.outputs.get("k8s")!);
    expect(docs).toHaveLength(36);

    // Count by kind
    const kinds = docs.map((d) => d.kind);
    expect(kinds.filter((k) => k === "Deployment")).toHaveLength(3); // app + external-dns + metrics-server
    expect(kinds.filter((k) => k === "Service")).toHaveLength(2); // app + metrics-server
    expect(kinds.filter((k) => k === "ServiceAccount")).toHaveLength(5); // app, fluent-bit, external-dns, adot, metrics-server
    expect(kinds.filter((k) => k === "ClusterRole")).toHaveLength(5); // fluent-bit, external-dns, adot, metrics-server, metrics-server-aggregated
    expect(kinds.filter((k) => k === "ClusterRoleBinding")).toHaveLength(5); // fluent-bit, external-dns, adot, metrics-server, metrics-server-auth-delegator
    expect(kinds.filter((k) => k === "ConfigMap")).toHaveLength(3); // app-config, fluent-bit-config, adot-config
    expect(kinds.filter((k) => k === "DaemonSet")).toHaveLength(2); // fluent-bit, adot
    expect(kinds.filter((k) => k === "Ingress")).toHaveLength(1); // ALB
    expect(kinds.filter((k) => k === "HorizontalPodAutoscaler")).toHaveLength(1);
    expect(kinds.filter((k) => k === "PodDisruptionBudget")).toHaveLength(1);
    expect(kinds.filter((k) => k === "StorageClass")).toHaveLength(1);
    expect(kinds.filter((k) => k === "Namespace")).toHaveLength(3); // microservice, amazon-cloudwatch, amazon-metrics
    expect(kinds.filter((k) => k === "ResourceQuota")).toHaveLength(1);
    expect(kinds.filter((k) => k === "LimitRange")).toHaveLength(1);
    expect(kinds.filter((k) => k === "NetworkPolicy")).toHaveLength(1);
    expect(kinds.filter((k) => k === "APIService")).toHaveLength(1); // metrics-server
  });

  // ── K8s: IRSA annotation on ServiceAccounts ────────────────────

  test("IRSA ServiceAccount has eks.amazonaws.com/role-arn annotation", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);

    const appSa = docs.find(
      (d) => d.kind === "ServiceAccount" && d.name === "microservice-app",
    );
    expect(appSa).toBeDefined();
    expect(appSa!.doc).toContain("eks.amazonaws.com/role-arn");
    expect(appSa!.doc).toContain("eks-microservice-app-role");
  });

  // ── K8s: ALB Ingress annotations ───────────────────────────────

  test("ALB Ingress has correct annotations and host rules", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);

    const ingress = docs.find((d) => d.kind === "Ingress");
    expect(ingress).toBeDefined();

    // ALB annotations
    expect(ingress!.doc).toContain("alb.ingress.kubernetes.io/scheme: internet-facing");
    expect(ingress!.doc).toContain("alb.ingress.kubernetes.io/target-type: ip");
    expect(ingress!.doc).toContain("alb.ingress.kubernetes.io/certificate-arn:");
    expect(ingress!.doc).toContain("alb.ingress.kubernetes.io/ssl-redirect: '443'");
    expect(ingress!.doc).toContain("alb.ingress.kubernetes.io/healthcheck-path: /");

    // Ingress class
    expect(ingress!.doc).toContain("ingressClassName: alb");

    // Host rule
    expect(ingress!.doc).toContain("host: api.example.com");
    expect(ingress!.doc).toContain("name: microservice-api");
  });

  // ── K8s: EBS StorageClass ──────────────────────────────────────

  test("EBS StorageClass uses ebs.csi.aws.com with gp3 encrypted", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);

    const sc = docs.find((d) => d.kind === "StorageClass");
    expect(sc).toBeDefined();
    expect(sc!.doc).toContain("provisioner: ebs.csi.aws.com");
    expect(sc!.doc).toContain("type: gp3");
    expect(sc!.doc).toContain("encrypted: 'true'");
    expect(sc!.doc).toContain("volumeBindingMode: WaitForFirstConsumer");
    expect(sc!.doc).toContain("allowVolumeExpansion: true");
  });

  // ── K8s: namespace propagation ─────────────────────────────────

  test("app resources are in the microservice namespace", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);

    // These should all be in the microservice namespace
    const namespacedNames = [
      "microservice-api",
      "microservice-app",
      "microservice-alb",
      "microservice-config",
      "microservice-quota",
      "microservice-limits",
      "microservice-default-deny",
    ];

    for (const name of namespacedNames) {
      const doc = docs.find((d) => d.name === name);
      expect(doc).toBeDefined();
      expect(doc!.doc).toContain("namespace: microservice");
    }

    // Cluster-scoped resources should NOT have a namespace
    const clusterScoped = docs.filter(
      (d) => d.kind === "ClusterRole" || d.kind === "ClusterRoleBinding" || d.kind === "StorageClass",
    );
    for (const doc of clusterScoped) {
      // ClusterRoles/ClusterRoleBindings/StorageClasses don't have namespace in metadata
      const metadataBlock = doc.doc.match(/metadata:\n([\s\S]*?)(?=\n\S|\n---|\z)/);
      if (metadataBlock) {
        const metaLines = metadataBlock[1].split("\n").filter((l) => l.match(/^\s+namespace:/));
        expect(metaLines).toHaveLength(0);
      }
    }
  });

  // ── K8s: label consistency ─────────────────────────────────────

  test("all resources have managed-by: chant label", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);

    for (const doc of docs) {
      expect(doc.doc).toContain("app.kubernetes.io/managed-by: chant");
    }
  });

  // ── K8s: HPA and PDB match deployment ──────────────────────────

  test("HPA and PDB target the correct deployment", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);

    const hpa = docs.find((d) => d.kind === "HorizontalPodAutoscaler");
    expect(hpa).toBeDefined();
    expect(hpa!.doc).toContain("name: microservice-api");
    expect(hpa!.doc).toContain("kind: Deployment");

    const pdb = docs.find((d) => d.kind === "PodDisruptionBudget");
    expect(pdb).toBeDefined();
    expect(pdb!.doc).toContain("app.kubernetes.io/name: microservice-api");
  });

  // ── K8s: Fluent Bit DaemonSet ──────────────────────────────────

  test("Fluent Bit DaemonSet has CloudWatch config and IRSA annotation", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);

    const ds = docs.find((d) => d.kind === "DaemonSet" && d.name.includes("fluent-bit"));
    expect(ds).toBeDefined();
    expect(ds!.doc).toContain("fluent-bit");

    // Fluent Bit ConfigMap references the cluster
    const fbConfig = docs.find(
      (d) => d.kind === "ConfigMap" && d.name === "fluent-bit-config",
    );
    expect(fbConfig).toBeDefined();
    expect(fbConfig!.doc).toContain("eks-microservice");
    expect(fbConfig!.doc).toContain("us-east-1");

    // Fluent Bit ServiceAccount has IRSA annotation
    const fbSa = docs.find(
      (d) => d.kind === "ServiceAccount" && d.name === "fluent-bit-sa",
    );
    expect(fbSa).toBeDefined();
    expect(fbSa!.doc).toContain("eks.amazonaws.com/role-arn");
    expect(fbSa!.doc).toContain("fluent-bit-role");
  });

  // ── K8s: ExternalDNS ───────────────────────────────────────────

  test("ExternalDNS deployment has correct args and IRSA", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);

    const deploy = docs.find(
      (d) => d.kind === "Deployment" && d.name === "external-dns",
    );
    expect(deploy).toBeDefined();
    expect(deploy!.doc).toContain("--domain-filter=example.com");
    expect(deploy!.doc).toContain("--provider=aws");
    expect(deploy!.doc).toContain("--txt-owner-id=eks-microservice");

    const sa = docs.find(
      (d) => d.kind === "ServiceAccount" && d.name === "external-dns-sa",
    );
    expect(sa).toBeDefined();
    expect(sa!.doc).toContain("eks.amazonaws.com/role-arn");
    expect(sa!.doc).toContain("external-dns-role");
  });

  // ── K8s: ADOT Collector ──────────────────────────────────────────

  test("ADOT Collector DaemonSet has metrics config and IRSA annotation", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);

    const ds = docs.find((d) => d.kind === "DaemonSet" && d.name.includes("adot"));
    expect(ds).toBeDefined();
    expect(ds!.doc).toContain("adot");

    // ADOT ConfigMap references the cluster
    const adotConfig = docs.find(
      (d) => d.kind === "ConfigMap" && d.name.includes("adot"),
    );
    expect(adotConfig).toBeDefined();

    // ADOT ServiceAccount has IRSA annotation
    const adotSa = docs.find(
      (d) => d.kind === "ServiceAccount" && d.name.includes("adot"),
    );
    expect(adotSa).toBeDefined();
    expect(adotSa!.doc).toContain("eks.amazonaws.com/role-arn");
    expect(adotSa!.doc).toContain("adot-role");
  });

  // ── K8s: agent namespaces ───────────────────────────────────────

  test("agent namespaces for CloudWatch and metrics exist", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);

    const cwNs = docs.find((d) => d.kind === "Namespace" && d.name === "amazon-cloudwatch");
    expect(cwNs).toBeDefined();
    expect(cwNs!.doc).toContain("app.kubernetes.io/managed-by: chant");

    const metricsNs = docs.find((d) => d.kind === "Namespace" && d.name === "amazon-metrics");
    expect(metricsNs).toBeDefined();
    expect(metricsNs!.doc).toContain("app.kubernetes.io/managed-by: chant");
  });

  // ── K8s: NamespaceEnv resources ────────────────────────────────

  test("NamespaceEnv creates quota, limits, and default-deny policy", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);

    // ResourceQuota
    const quota = docs.find((d) => d.kind === "ResourceQuota");
    expect(quota).toBeDefined();
    expect(quota!.doc).toContain("limits.cpu: '4'");
    expect(quota!.doc).toContain("limits.memory: '8Gi'");
    expect(quota!.doc).toContain("pods: '50'");

    // LimitRange
    const limits = docs.find((d) => d.kind === "LimitRange");
    expect(limits).toBeDefined();
    expect(limits!.doc).toContain("cpu: '100m'");
    expect(limits!.doc).toContain("memory: '128Mi'");

    // NetworkPolicy (default deny ingress)
    const netpol = docs.find((d) => d.kind === "NetworkPolicy");
    expect(netpol).toBeDefined();
    expect(netpol!.doc).toContain("podSelector: {}");
    expect(netpol!.doc).toContain("Ingress");
  });

  // ── K8s: Pod Security Standards labels ────────────────────────

  test("namespace has PSS enforce=restricted labels", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);

    const ns = docs.find((d) => d.kind === "Namespace" && d.name === "microservice");
    expect(ns).toBeDefined();
    expect(ns!.doc).toContain("pod-security.kubernetes.io/enforce: restricted");
    expect(ns!.doc).toContain("pod-security.kubernetes.io/warn: restricted");
    expect(ns!.doc).toContain("pod-security.kubernetes.io/audit: restricted");
  });

  // ── K8s: health probes ────────────────────────────────────────

  test("app deployment has liveness and readiness probes", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);

    const deploy = docs.find(
      (d) => d.kind === "Deployment" && d.name === "microservice-api",
    );
    expect(deploy).toBeDefined();
    expect(deploy!.doc).toContain("livenessProbe:");
    expect(deploy!.doc).toContain("readinessProbe:");
    expect(deploy!.doc).toContain("path: /");
  });

  // ── K8s: topology spread constraints ──────────────────────────

  test("app deployment has topology spread constraints", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);

    const deploy = docs.find(
      (d) => d.kind === "Deployment" && d.name === "microservice-api",
    );
    expect(deploy).toBeDefined();
    expect(deploy!.doc).toContain("topologySpreadConstraints:");
    expect(deploy!.doc).toContain("topology.kubernetes.io/zone");
  });

  // ── K8s: MetricsServer ────────────────────────────────────────

  test("MetricsServer deployment and service in kube-system", async () => {
    const result = await build(srcDir, [k8sSerializer]);
    const docs = parseK8sDocs(result.outputs.get("k8s")!);

    const deploy = docs.find(
      (d) => d.kind === "Deployment" && d.name === "metrics-server",
    );
    expect(deploy).toBeDefined();
    expect(deploy!.doc).toContain("namespace: kube-system");
    expect(deploy!.doc).toContain("--secure-port=10250");

    const svc = docs.find(
      (d) => d.kind === "Service" && d.name === "metrics-server",
    );
    expect(svc).toBeDefined();
    expect(svc!.doc).toContain("targetPort: 10250");

    const apiSvc = docs.find((d) => d.kind === "APIService");
    expect(apiSvc).toBeDefined();
    expect(apiSvc!.doc).toContain("metrics.k8s.io");
  });

  // ── CloudFormation: parameters ──────────────────────────────────

  test("CloudFormation template has parameters section", async () => {
    const result = await build(srcDir, [awsSerializer]);
    const parsed = JSON.parse(result.outputs.get("aws")!);

    expect(parsed.Parameters).toBeDefined();
    const paramNames = Object.keys(parsed.Parameters);
    expect(paramNames).toContain("environment");
    expect(paramNames).toContain("domainName");
    expect(paramNames).toContain("certificateArn");
    expect(paramNames).toContain("publicAccessCidr");

    expect(parsed.Parameters.environment.Default).toBe("dev");
    expect(parsed.Parameters.domainName.Default).toBe("api.example.com");
    expect(parsed.Parameters.publicAccessCidr.Default).toBe("0.0.0.0/0");
  });
});
