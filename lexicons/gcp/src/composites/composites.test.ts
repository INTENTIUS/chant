import { describe, test, expect } from "vitest";
import { GkeCluster } from "./gke-cluster";
import { CloudRunServiceComposite } from "./cloud-run-service";
import { CloudSqlInstance } from "./cloud-sql-instance";
import { GcsBucket } from "./gcs-bucket";
import { VpcNetwork } from "./vpc-network";
import { PubSubPipeline } from "./pubsub-pipeline";
import { CloudFunctionWithTrigger } from "./cloud-function";
import { PrivateService } from "./private-service";
import { ManagedCertificate } from "./managed-certificate";
import { SecureProject } from "./secure-project";

/** Helper to extract props from a Declarable member. */
function p(member: unknown): Record<string, any> {
  return (member as any).props;
}

// ── GkeCluster ──────────────────────────────────────────────────────

describe("GkeCluster", () => {
  test("returns cluster and node pool", () => {
    const result = GkeCluster({ name: "my-cluster" });
    expect(result.cluster).toBeDefined();
    expect(result.nodePool).toBeDefined();
  });

  test("includes common labels", () => {
    const result = GkeCluster({ name: "my-cluster" });
    const meta = p(result.cluster).metadata;
    expect(meta.labels["app.kubernetes.io/managed-by"]).toBe("chant");
  });

  test("node pool references cluster", () => {
    const result = GkeCluster({ name: "my-cluster" });
    expect(p(result.nodePool).clusterRef.name).toBe("my-cluster");
  });

  test("respects maxNodeCount", () => {
    const result = GkeCluster({ name: "c", maxNodeCount: 20 });
    expect(p(result.nodePool).autoscaling.maxNodeCount).toBe(20);
  });

  test("sets namespace when provided", () => {
    const result = GkeCluster({ name: "c", namespace: "infra" });
    expect(p(result.cluster).metadata.namespace).toBe("infra");
    expect(p(result.nodePool).metadata.namespace).toBe("infra");
  });

  test("enables workload identity by default", () => {
    const result = GkeCluster({ name: "c" });
    expect(p(result.cluster).workloadIdentityConfig).toBeDefined();
    expect(p(result.nodePool).nodeConfig.workloadMetadataConfig).toBeDefined();
  });

  test("workloadPool uses explicit projectId", () => {
    const result = GkeCluster({ name: "c", projectId: "my-project-123" });
    expect(p(result.cluster).workloadIdentityConfig.workloadPool).toBe(
      "my-project-123.svc.id.goog",
    );
  });

  test("workloadPool falls back to GCP_PROJECT_ID env var", () => {
    const prev = process.env.GCP_PROJECT_ID;
    process.env.GCP_PROJECT_ID = "env-project-456";
    try {
      const result = GkeCluster({ name: "c" });
      expect(p(result.cluster).workloadIdentityConfig.workloadPool).toBe(
        "env-project-456.svc.id.goog",
      );
    } finally {
      if (prev === undefined) delete process.env.GCP_PROJECT_ID;
      else process.env.GCP_PROJECT_ID = prev;
    }
  });
});

// ── CloudRunService ─────────────────────────────────────────────────

describe("CloudRunServiceComposite", () => {
  test("returns service", () => {
    const result = CloudRunServiceComposite({ name: "api", image: "gcr.io/p/api:1" });
    expect(result.service).toBeDefined();
  });

  test("no public IAM by default", () => {
    const result = CloudRunServiceComposite({ name: "api", image: "gcr.io/p/api:1" });
    expect(result.publicIam).toBeUndefined();
  });

  test("creates public IAM when requested", () => {
    const result = CloudRunServiceComposite({
      name: "api",
      image: "gcr.io/p/api:1",
      publicAccess: true,
    });
    expect(result.publicIam).toBeDefined();
    expect(p(result.publicIam).member).toBe("allUsers");
    expect(p(result.publicIam).role).toBe("roles/run.invoker");
  });

  test("sets custom port", () => {
    const result = CloudRunServiceComposite({ name: "api", image: "img", port: 3000 });
    const containers = p(result.service).template.containers;
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
    expect(p(result.database).instanceRef.name).toBe("db");
  });

  test("default database version is POSTGRES_15", () => {
    const result = CloudSqlInstance({ name: "db" });
    expect(p(result.instance).databaseVersion).toBe("POSTGRES_15");
  });

  test("enables backups by default", () => {
    const result = CloudSqlInstance({ name: "db" });
    expect(p(result.instance).settings.backupConfiguration.enabled).toBe(true);
  });

  test("high availability when requested", () => {
    const result = CloudSqlInstance({ name: "db", highAvailability: true });
    expect(p(result.instance).settings.availabilityType).toBe("REGIONAL");
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
    expect(p(result.bucket).uniformBucketLevelAccess).toBe(true);
  });

  test("adds lifecycle rules", () => {
    const result = GcsBucket({
      name: "my-bucket",
      lifecycleDeleteAfterDays: 30,
    });
    expect(p(result.bucket).lifecycleRule).toHaveLength(1);
    expect(p(result.bucket).lifecycleRule[0].condition.age).toBe(30);
  });

  test("adds encryption when kmsKeyName provided", () => {
    const result = GcsBucket({
      name: "my-bucket",
      kmsKeyName: "projects/p/locations/l/keyRings/kr/cryptoKeys/k",
    });
    expect(p(result.bucket).encryption).toBeDefined();
  });

  test("versioning disabled by default", () => {
    const result = GcsBucket({ name: "my-bucket" });
    expect(p(result.bucket).versioning).toBeUndefined();
  });

  test("versioning enabled when requested", () => {
    const result = GcsBucket({ name: "my-bucket", versioning: true });
    expect(p(result.bucket).versioning.enabled).toBe(true);
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
    expect(result.subnet_app).toBeDefined();
    expect(p(result.subnet_app).ipCidrRange).toBe("10.0.0.0/24");
  });

  test("subnet references network", () => {
    const result = VpcNetwork({
      name: "my-vpc",
      subnets: [{ name: "app", ipCidrRange: "10.0.0.0/24", region: "us-central1" }],
    });
    expect(p(result.subnet_app).networkRef.name).toBe("my-vpc");
  });

  test("creates internal firewall by default", () => {
    const result = VpcNetwork({
      name: "my-vpc",
      subnets: [{ name: "app", ipCidrRange: "10.0.0.0/24", region: "us-central1" }],
    });
    expect(result.firewallAllowInternal).toBeDefined();
    expect(p(result.firewallAllowInternal).metadata.name).toBe("my-vpc-allow-internal");
  });

  test("creates NAT when enabled", () => {
    const result = VpcNetwork({
      name: "my-vpc",
      enableNat: true,
      natRegion: "us-central1",
    });
    expect(result.router).toBeDefined();
    expect(result.routerNat).toBeDefined();
    expect(p(result.routerNat).routerRef.name).toBe("my-vpc-router");
  });

  test("no NAT by default", () => {
    const result = VpcNetwork({ name: "my-vpc" });
    expect(result.router).toBeUndefined();
    expect(result.routerNat).toBeUndefined();
  });

  test("IAP SSH firewall when requested", () => {
    const result = VpcNetwork({ name: "my-vpc", allowIapSsh: true });
    expect(result.firewallAllowIapSsh).toBeDefined();
    expect(p(result.firewallAllowIapSsh).sourceRanges).toContain("35.235.240.0/20");
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
    expect(p(result.subscription).topicRef.name).toBe("events-topic");
  });

  test("no DLQ by default", () => {
    const result = PubSubPipeline({ name: "events" });
    expect(result.deadLetterTopic).toBeUndefined();
  });

  test("creates DLQ when enabled", () => {
    const result = PubSubPipeline({ name: "events", enableDeadLetterQueue: true });
    expect(result.deadLetterTopic).toBeDefined();
    expect(p(result.deadLetterTopic).metadata.name).toBe("events-dlq");
    expect(p(result.subscription).deadLetterPolicy.deadLetterTopicRef.name).toBe("events-dlq");
  });

  test("creates subscriber IAM when service account provided", () => {
    const result = PubSubPipeline({
      name: "events",
      subscriberServiceAccount: "worker@project.iam.gserviceaccount.com",
    });
    expect(result.subscriberIam).toBeDefined();
    expect(p(result.subscriberIam).role).toBe("roles/pubsub.subscriber");
  });

  test("sets namespace when provided", () => {
    const result = PubSubPipeline({ name: "events", namespace: "infra" });
    expect(p(result.topic).metadata.namespace).toBe("infra");
    expect(p(result.subscription).metadata.namespace).toBe("infra");
  });

  test("includes managed-by label", () => {
    const result = PubSubPipeline({ name: "events" });
    expect(p(result.topic).metadata.labels["app.kubernetes.io/managed-by"]).toBe("chant");
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
    expect(p(result.invokerIam).member).toBe("allUsers");
    expect(p(result.invokerIam).role).toBe("roles/cloudfunctions.invoker");
  });

  test("sets runtime and entry point", () => {
    const result = CloudFunctionWithTrigger({
      name: "my-fn",
      runtime: "python312",
      entryPoint: "main",
    });
    expect(p(result.function).runtime).toBe("python312");
    expect(p(result.function).entryPoint).toBe("main");
  });

  test("configures pubsub trigger", () => {
    const result = CloudFunctionWithTrigger({
      name: "my-fn",
      runtime: "nodejs20",
      entryPoint: "handler",
      triggerType: "pubsub",
      triggerTopic: "my-topic",
    });
    expect(p(result.function).eventTrigger).toBeDefined();
    expect(p(result.function).eventTrigger.pubsubTopic).toBe("my-topic");
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
    expect(p(result.globalAddress).networkRef.name).toBe("my-vpc");
  });

  test("connection references network", () => {
    const result = PrivateService({ name: "db", networkName: "my-vpc" });
    expect(p(result.serviceConnection).networkRef.name).toBe("my-vpc");
  });

  test("no DNS by default", () => {
    const result = PrivateService({ name: "db", networkName: "my-vpc" });
    expect(result.dnsZone).toBeUndefined();
  });

  test("creates DNS zone when enabled", () => {
    const result = PrivateService({ name: "db", networkName: "my-vpc", enableDns: true });
    expect(result.dnsZone).toBeDefined();
    expect(p(result.dnsZone).visibility).toBe("private");
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
    expect(p(result.certificate).managed.domains).toEqual(["example.com", "www.example.com"]);
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
    expect(p(result.urlMap).defaultService.backendServiceRef.name).toBe("my-backend");
  });
});

// ── SecureProject ──────────────────────────────────────────────────

describe("SecureProject", () => {
  test("returns project, audit config, and services", () => {
    const result = SecureProject({ name: "my-project" });
    expect(result.project).toBeDefined();
    expect(result.auditConfig).toBeDefined();
    // Default 5 APIs become service_compute, service_container, etc.
    expect(result.service_compute).toBeDefined();
    expect(result.service_container).toBeDefined();
    expect(result.service_iam).toBeDefined();
    expect(result.service_logging).toBeDefined();
    expect(result.service_monitoring).toBeDefined();
  });

  test("audit config covers all services", () => {
    const result = SecureProject({ name: "my-project" });
    expect(p(result.auditConfig).service).toBe("allServices");
    expect(p(result.auditConfig).auditLogConfigs.length).toBe(3);
  });

  test("enables default APIs", () => {
    const result = SecureProject({ name: "my-project" });
    // 5 services as individual members
    const serviceKeys = Object.keys(result.members).filter((k) => k.startsWith("service_"));
    expect(serviceKeys.length).toBe(5);
    expect(p(result.service_compute).resourceID).toBe("compute.googleapis.com");
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
    expect(p(result.ownerIam).member).toBe("user:admin@example.com");
    expect(p(result.ownerIam).role).toBe("roles/owner");
  });

  test("creates logging sink when destination provided", () => {
    const result = SecureProject({
      name: "my-project",
      loggingSinkDestination: "bigquery.googleapis.com/projects/my-project/datasets/audit_logs",
    });
    expect(result.loggingSink).toBeDefined();
    expect(p(result.loggingSink).destination).toContain("bigquery");
  });

  test("no logging sink by default", () => {
    const result = SecureProject({ name: "my-project" });
    expect(result.loggingSink).toBeUndefined();
  });
});
