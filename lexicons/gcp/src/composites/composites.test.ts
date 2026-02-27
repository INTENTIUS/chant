import { describe, test, expect } from "bun:test";
import { GkeCluster } from "./gke-cluster";
import { CloudRunService } from "./cloud-run-service";
import { CloudSqlInstance } from "./cloud-sql-instance";
import { GcsBucket } from "./gcs-bucket";
import { VpcNetwork } from "./vpc-network";

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
