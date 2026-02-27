import { describe, test, expect } from "bun:test";
import { GkeCluster } from "./gke-cluster";
import { CloudRunService } from "./cloud-run-service";
import { CloudSqlInstance } from "./cloud-sql-instance";
import { GcsBucket } from "./gcs-bucket";
import { VpcNetwork } from "./vpc-network";
import { PubSubPipeline } from "./pubsub-pipeline";
import { CloudFunctionWithTrigger } from "./cloud-function";
import { PrivateService } from "./private-service";
import { ManagedCertificate } from "./managed-certificate";
import { SecureProject } from "./secure-project";

// ── GkeCluster ──────────────────────────────────────────────────────

describe("GkeCluster", () => {
  test("returns cluster and node pool", () => {
    const result = GkeCluster({ name: "my-cluster" });
    expect(result.cluster).toBeDefined();
    expect(result.nodePool).toBeDefined();
  });

  test("includes common labels", () => {
    const result = GkeCluster({ name: "my-cluster" });
    const labels = result.cluster.metadata as any;
    expect(labels.labels["app.kubernetes.io/managed-by"]).toBe("chant");
  });

  test("node pool references cluster", () => {
    const result = GkeCluster({ name: "my-cluster" });
    expect((result.nodePool as any).clusterRef.name).toBe("my-cluster");
  });

  test("respects maxNodeCount", () => {
    const result = GkeCluster({ name: "c", maxNodeCount: 20 });
    expect((result.nodePool as any).autoscaling.maxNodeCount).toBe(20);
  });

  test("sets namespace when provided", () => {
    const result = GkeCluster({ name: "c", namespace: "infra" });
    expect((result.cluster.metadata as any).namespace).toBe("infra");
    expect((result.nodePool.metadata as any).namespace).toBe("infra");
  });

  test("enables workload identity by default", () => {
    const result = GkeCluster({ name: "c" });
    expect((result.cluster as any).workloadIdentityConfig).toBeDefined();
    expect((result.nodePool as any).nodeConfig.workloadMetadataConfig).toBeDefined();
  });
});

// ── CloudRunService ─────────────────────────────────────────────────

describe("CloudRunService", () => {
  test("returns service", () => {
    const result = CloudRunService({ name: "api", image: "gcr.io/p/api:1" });
    expect(result.service).toBeDefined();
  });

  test("no public IAM by default", () => {
    const result = CloudRunService({ name: "api", image: "gcr.io/p/api:1" });
    expect(result.publicIam).toBeUndefined();
  });

  test("creates public IAM when requested", () => {
    const result = CloudRunService({
      name: "api",
      image: "gcr.io/p/api:1",
      publicAccess: true,
    });
    expect(result.publicIam).toBeDefined();
    expect((result.publicIam as any).member).toBe("allUsers");
    expect((result.publicIam as any).role).toBe("roles/run.invoker");
  });

  test("sets custom port", () => {
    const result = CloudRunService({ name: "api", image: "img", port: 3000 });
    const containers = (result.service as any).template.containers;
    expect(containers[0].ports[0].containerPort).toBe(3000);
  });
});

// ── CloudSqlInstance ────────────────────────────────────────────────

describe("CloudSqlInstance", () => {
  test("returns instance, database, and user", () => {
    const result = CloudSqlInstance({ name: "db" });
    expect(result.instance).toBeDefined();
    expect(result.database).toBeDefined();
    expect(result.user).toBeDefined();
  });

  test("database references instance", () => {
    const result = CloudSqlInstance({ name: "db" });
    expect((result.database as any).instanceRef.name).toBe("db");
  });

  test("default database version is POSTGRES_15", () => {
    const result = CloudSqlInstance({ name: "db" });
    expect((result.instance as any).databaseVersion).toBe("POSTGRES_15");
  });

  test("enables backups by default", () => {
    const result = CloudSqlInstance({ name: "db" });
    expect((result.instance as any).settings.backupConfiguration.enabled).toBe(true);
  });

  test("high availability when requested", () => {
    const result = CloudSqlInstance({ name: "db", highAvailability: true });
    expect((result.instance as any).settings.availabilityType).toBe("REGIONAL");
  });
});

// ── GcsBucket ───────────────────────────────────────────────────────

describe("GcsBucket", () => {
  test("returns bucket", () => {
    const result = GcsBucket({ name: "my-bucket" });
    expect(result.bucket).toBeDefined();
  });

  test("uniform access enabled by default", () => {
    const result = GcsBucket({ name: "my-bucket" });
    expect((result.bucket as any).uniformBucketLevelAccess).toBe(true);
  });

  test("adds lifecycle rules", () => {
    const result = GcsBucket({
      name: "my-bucket",
      lifecycleDeleteAfterDays: 30,
    });
    expect((result.bucket as any).lifecycleRule).toHaveLength(1);
    expect((result.bucket as any).lifecycleRule[0].condition.age).toBe(30);
  });

  test("adds encryption when kmsKeyName provided", () => {
    const result = GcsBucket({
      name: "my-bucket",
      kmsKeyName: "projects/p/locations/l/keyRings/kr/cryptoKeys/k",
    });
    expect((result.bucket as any).encryption).toBeDefined();
  });

  test("versioning disabled by default", () => {
    const result = GcsBucket({ name: "my-bucket" });
    expect((result.bucket as any).versioning).toBeUndefined();
  });

  test("versioning enabled when requested", () => {
    const result = GcsBucket({ name: "my-bucket", versioning: true });
    expect((result.bucket as any).versioning.enabled).toBe(true);
  });
});

// ── VpcNetwork ──────────────────────────────────────────────────────

describe("VpcNetwork", () => {
  test("returns network", () => {
    const result = VpcNetwork({ name: "my-vpc" });
    expect(result.network).toBeDefined();
  });

  test("creates subnets", () => {
    const result = VpcNetwork({
      name: "my-vpc",
      subnets: [
        { name: "app", ipCidrRange: "10.0.0.0/24", region: "us-central1" },
      ],
    });
    expect(result.subnets).toHaveLength(1);
    expect((result.subnets[0] as any).ipCidrRange).toBe("10.0.0.0/24");
  });

  test("subnet references network", () => {
    const result = VpcNetwork({
      name: "my-vpc",
      subnets: [{ name: "app", ipCidrRange: "10.0.0.0/24", region: "us-central1" }],
    });
    expect((result.subnets[0] as any).networkRef.name).toBe("my-vpc");
  });

  test("creates internal firewall by default", () => {
    const result = VpcNetwork({
      name: "my-vpc",
      subnets: [{ name: "app", ipCidrRange: "10.0.0.0/24", region: "us-central1" }],
    });
    expect(result.firewalls.length).toBeGreaterThanOrEqual(1);
    expect((result.firewalls[0] as any).metadata.name).toBe("my-vpc-allow-internal");
  });

  test("creates NAT when enabled", () => {
    const result = VpcNetwork({
      name: "my-vpc",
      enableNat: true,
      natRegion: "us-central1",
    });
    expect(result.router).toBeDefined();
    expect(result.routerNat).toBeDefined();
    expect((result.routerNat as any).routerRef.name).toBe("my-vpc-router");
  });

  test("no NAT by default", () => {
    const result = VpcNetwork({ name: "my-vpc" });
    expect(result.router).toBeUndefined();
    expect(result.routerNat).toBeUndefined();
  });

  test("IAP SSH firewall when requested", () => {
    const result = VpcNetwork({ name: "my-vpc", allowIapSsh: true });
    const iapFw = result.firewalls.find((f: any) => (f.metadata as any).name.includes("iap-ssh"));
    expect(iapFw).toBeDefined();
    expect((iapFw as any).sourceRanges).toContain("35.235.240.0/20");
  });
});

// ── PubSubPipeline ─────────────────────────────────────────────────

describe("PubSubPipeline", () => {
  test("returns topic and subscription", () => {
    const result = PubSubPipeline({ name: "events" });
    expect(result.topic).toBeDefined();
    expect(result.subscription).toBeDefined();
  });

  test("subscription references topic", () => {
    const result = PubSubPipeline({ name: "events" });
    expect((result.subscription as any).topicRef.name).toBe("events-topic");
  });

  test("no DLQ by default", () => {
    const result = PubSubPipeline({ name: "events" });
    expect(result.deadLetterTopic).toBeUndefined();
  });

  test("creates DLQ when enabled", () => {
    const result = PubSubPipeline({ name: "events", enableDeadLetterQueue: true });
    expect(result.deadLetterTopic).toBeDefined();
    expect((result.deadLetterTopic as any).metadata.name).toBe("events-dlq");
    expect((result.subscription as any).deadLetterPolicy.deadLetterTopicRef.name).toBe("events-dlq");
  });

  test("creates subscriber IAM when service account provided", () => {
    const result = PubSubPipeline({
      name: "events",
      subscriberServiceAccount: "worker@project.iam.gserviceaccount.com",
    });
    expect(result.subscriberIam).toBeDefined();
    expect((result.subscriberIam as any).role).toBe("roles/pubsub.subscriber");
  });

  test("sets namespace when provided", () => {
    const result = PubSubPipeline({ name: "events", namespace: "infra" });
    expect((result.topic as any).metadata.namespace).toBe("infra");
    expect((result.subscription as any).metadata.namespace).toBe("infra");
  });

  test("includes managed-by label", () => {
    const result = PubSubPipeline({ name: "events" });
    expect((result.topic as any).metadata.labels["app.kubernetes.io/managed-by"]).toBe("chant");
  });
});

// ── CloudFunctionWithTrigger ───────────────────────────────────────

describe("CloudFunctionWithTrigger", () => {
  test("returns function and source bucket", () => {
    const result = CloudFunctionWithTrigger({
      name: "my-fn",
      runtime: "nodejs20",
      entryPoint: "handler",
    });
    expect(result.function).toBeDefined();
    expect(result.sourceBucket).toBeDefined();
  });

  test("no invoker IAM by default", () => {
    const result = CloudFunctionWithTrigger({
      name: "my-fn",
      runtime: "nodejs20",
      entryPoint: "handler",
    });
    expect(result.invokerIam).toBeUndefined();
  });

  test("creates invoker IAM when public access enabled", () => {
    const result = CloudFunctionWithTrigger({
      name: "my-fn",
      runtime: "nodejs20",
      entryPoint: "handler",
      publicAccess: true,
    });
    expect(result.invokerIam).toBeDefined();
    expect((result.invokerIam as any).member).toBe("allUsers");
    expect((result.invokerIam as any).role).toBe("roles/cloudfunctions.invoker");
  });

  test("sets runtime and entry point", () => {
    const result = CloudFunctionWithTrigger({
      name: "my-fn",
      runtime: "python312",
      entryPoint: "main",
    });
    expect((result.function as any).runtime).toBe("python312");
    expect((result.function as any).entryPoint).toBe("main");
  });

  test("configures pubsub trigger", () => {
    const result = CloudFunctionWithTrigger({
      name: "my-fn",
      runtime: "nodejs20",
      entryPoint: "handler",
      triggerType: "pubsub",
      triggerTopic: "my-topic",
    });
    expect((result.function as any).eventTrigger).toBeDefined();
    expect((result.function as any).eventTrigger.pubsubTopic).toBe("my-topic");
  });
});

// ── PrivateService ─────────────────────────────────────────────────

describe("PrivateService", () => {
  test("returns global address and service connection", () => {
    const result = PrivateService({ name: "db", networkName: "my-vpc" });
    expect(result.globalAddress).toBeDefined();
    expect(result.serviceConnection).toBeDefined();
  });

  test("address references network", () => {
    const result = PrivateService({ name: "db", networkName: "my-vpc" });
    expect((result.globalAddress as any).networkRef.name).toBe("my-vpc");
  });

  test("connection references network", () => {
    const result = PrivateService({ name: "db", networkName: "my-vpc" });
    expect((result.serviceConnection as any).networkRef.name).toBe("my-vpc");
  });

  test("no DNS by default", () => {
    const result = PrivateService({ name: "db", networkName: "my-vpc" });
    expect(result.dnsZone).toBeUndefined();
  });

  test("creates DNS zone when enabled", () => {
    const result = PrivateService({ name: "db", networkName: "my-vpc", enableDns: true });
    expect(result.dnsZone).toBeDefined();
    expect((result.dnsZone as any).visibility).toBe("private");
  });
});

// ── ManagedCertificate ─────────────────────────────────────────────

describe("ManagedCertificate", () => {
  test("returns certificate", () => {
    const result = ManagedCertificate({ name: "my-cert", domains: ["example.com"] });
    expect(result.certificate).toBeDefined();
  });

  test("certificate includes domains", () => {
    const result = ManagedCertificate({ name: "my-cert", domains: ["example.com", "www.example.com"] });
    expect((result.certificate as any).managed.domains).toEqual(["example.com", "www.example.com"]);
  });

  test("no proxy by default", () => {
    const result = ManagedCertificate({ name: "my-cert", domains: ["example.com"] });
    expect(result.targetHttpsProxy).toBeUndefined();
    expect(result.urlMap).toBeUndefined();
  });

  test("creates proxy and url map when requested", () => {
    const result = ManagedCertificate({
      name: "my-cert",
      domains: ["example.com"],
      createProxy: true,
      backendServiceName: "my-backend",
    });
    expect(result.targetHttpsProxy).toBeDefined();
    expect(result.urlMap).toBeDefined();
    expect((result.urlMap as any).defaultService.backendServiceRef.name).toBe("my-backend");
  });
});

// ── SecureProject ──────────────────────────────────────────────────

describe("SecureProject", () => {
  test("returns project, audit config, and services", () => {
    const result = SecureProject({ name: "my-project" });
    expect(result.project).toBeDefined();
    expect(result.auditConfig).toBeDefined();
    expect(result.services.length).toBeGreaterThan(0);
  });

  test("audit config covers all services", () => {
    const result = SecureProject({ name: "my-project" });
    expect((result.auditConfig as any).service).toBe("allServices");
    expect((result.auditConfig as any).auditLogConfigs.length).toBe(3);
  });

  test("enables default APIs", () => {
    const result = SecureProject({ name: "my-project" });
    expect(result.services.length).toBe(5);
    expect(result.services.some((s: any) => s.resourceID === "compute.googleapis.com")).toBe(true);
  });

  test("no owner IAM by default", () => {
    const result = SecureProject({ name: "my-project" });
    expect(result.ownerIam).toBeUndefined();
  });

  test("creates owner IAM when provided", () => {
    const result = SecureProject({
      name: "my-project",
      owner: "user:admin@example.com",
    });
    expect(result.ownerIam).toBeDefined();
    expect((result.ownerIam as any).member).toBe("user:admin@example.com");
    expect((result.ownerIam as any).role).toBe("roles/owner");
  });

  test("creates logging sink when destination provided", () => {
    const result = SecureProject({
      name: "my-project",
      loggingSinkDestination: "bigquery.googleapis.com/projects/my-project/datasets/audit_logs",
    });
    expect(result.loggingSink).toBeDefined();
    expect((result.loggingSink as any).destination).toContain("bigquery");
  });

  test("no logging sink by default", () => {
    const result = SecureProject({ name: "my-project" });
    expect(result.loggingSink).toBeUndefined();
  });
});
