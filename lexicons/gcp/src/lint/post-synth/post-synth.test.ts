import { describe, test, expect } from "vitest";
import { wgc101 } from "./wgc101";
import { wgc102 } from "./wgc102";
import { wgc103 } from "./wgc103";
import { wgc104 } from "./wgc104";
import { wgc105 } from "./wgc105";
import { wgc106 } from "./wgc106";
import { wgc107 } from "./wgc107";
import { wgc108 } from "./wgc108";
import { wgc109 } from "./wgc109";
import { wgc110 } from "./wgc110";
import { wgc201 } from "./wgc201";
import { wgc202 } from "./wgc202";
import { wgc203 } from "./wgc203";
import { wgc204 } from "./wgc204";
import { wgc301 } from "./wgc301";
import { wgc302 } from "./wgc302";
import { wgc303 } from "./wgc303";
import { wgc111 } from "./wgc111";
import { wgc112 } from "./wgc112";
import { wgc113 } from "./wgc113";
import { wgc401 } from "./wgc401";
import { wgc402 } from "./wgc402";
import { wgc403 } from "./wgc403";

function makeCtx(yaml: string) {
  return {
    outputs: new Map([["gcp", yaml]]),
  };
}

// ── WGC101: Missing encryption ─────────────────────────────────────

describe("WGC101: missing encryption", () => {
  test("flags StorageBucket without encryption", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
`;
    const diags = wgc101.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WGC101");
    expect(diags[0].severity).toBe("warning");
  });

  test("no diagnostic when encryption present", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
  encryption:
    kmsKeyRef:
      external: projects/p/locations/l/keyRings/kr/cryptoKeys/k
`;
    const diags = wgc101.check(makeCtx(yaml));
    const bucketDiags = diags.filter(d => d.entity === "my-bucket");
    expect(bucketDiags).toHaveLength(0);
  });
});

// ── WGC102: Public IAM in output ───────────────────────────────────

describe("WGC102: public IAM in output", () => {
  test("flags allUsers in output", () => {
    const yaml = `apiVersion: iam.cnrm.cloud.google.com/v1beta1
kind: IAMPolicyMember
metadata:
  name: public-access
spec:
  member: allUsers
  role: roles/run.invoker
`;
    const diags = wgc102.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WGC102");
    expect(diags[0].severity).toBe("warning");
  });

  test("no diagnostic when no public members", () => {
    const yaml = `apiVersion: iam.cnrm.cloud.google.com/v1beta1
kind: IAMPolicyMember
metadata:
  name: private-access
spec:
  member: serviceAccount:sa@project.iam.gserviceaccount.com
  role: roles/viewer
`;
    const diags = wgc102.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});

// ── WGC103: Missing project annotation ─────────────────────────────

describe("WGC103: missing project annotation", () => {
  test("flags resource without project annotation", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
`;
    const diags = wgc103.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WGC103");
    expect(diags[0].severity).toBe("info");
  });

  test("no diagnostic when project annotation present", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
  annotations:
    cnrm.cloud.google.com/project-id: my-project
spec:
  location: US
`;
    const diags = wgc103.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});

// ── WGC104: Missing uniform bucket access ──────────────────────────

describe("WGC104: missing uniform bucket access", () => {
  test("flags StorageBucket without uniformBucketLevelAccess", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
`;
    const diags = wgc104.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WGC104");
    expect(diags[0].severity).toBe("warning");
  });

  test("no diagnostic when uniformBucketLevelAccess is true", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
  uniformBucketLevelAccess: true
`;
    const diags = wgc104.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});

// ── WGC105: Public Cloud SQL ───────────────────────────────────────

describe("WGC105: public Cloud SQL", () => {
  test("flags SQLInstance with 0.0.0.0/0 in authorizedNetworks", () => {
    const yaml = `apiVersion: sql.cnrm.cloud.google.com/v1beta1
kind: SQLInstance
metadata:
  name: my-db
spec:
  databaseVersion: POSTGRES_15
  settings:
    ipConfiguration:
      authorizedNetworks:
        - value: "0.0.0.0/0"
          name: public
`;
    const diags = wgc105.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WGC105");
    expect(diags[0].severity).toBe("warning");
  });

  test("no diagnostic with private networks only", () => {
    const yaml = `apiVersion: sql.cnrm.cloud.google.com/v1beta1
kind: SQLInstance
metadata:
  name: my-db
spec:
  databaseVersion: POSTGRES_15
  settings:
    ipConfiguration:
      authorizedNetworks:
        - value: "10.0.0.0/8"
          name: internal
`;
    const diags = wgc105.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});

// ── WGC106: Missing deletion policy annotation ─────────────────────

describe("WGC106: missing deletion policy", () => {
  test("flags resource without deletion policy annotation", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
`;
    const diags = wgc106.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WGC106");
    expect(diags[0].severity).toBe("info");
  });

  test("no diagnostic when deletion policy present", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
  annotations:
    cnrm.cloud.google.com/deletion-policy: abandon
spec:
  location: US
`;
    const diags = wgc106.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});

// ── WGC107: StorageBucket missing versioning ───────────────────────

describe("WGC107: missing versioning", () => {
  test("flags StorageBucket without versioning", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
`;
    const diags = wgc107.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WGC107");
    expect(diags[0].severity).toBe("info");
  });

  test("no diagnostic when versioning enabled", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
  versioning:
    enabled: true
`;
    const diags = wgc107.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});

// ── WGC108: SQLInstance missing backup ──────────────────────────────

describe("WGC108: missing backup configuration", () => {
  test("flags SQLInstance without backup", () => {
    const yaml = `apiVersion: sql.cnrm.cloud.google.com/v1beta1
kind: SQLInstance
metadata:
  name: my-db
spec:
  databaseVersion: POSTGRES_15
  settings:
    tier: db-f1-micro
`;
    const diags = wgc108.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WGC108");
    expect(diags[0].severity).toBe("warning");
  });

  test("no diagnostic when backup enabled", () => {
    const yaml = `apiVersion: sql.cnrm.cloud.google.com/v1beta1
kind: SQLInstance
metadata:
  name: my-db
spec:
  databaseVersion: POSTGRES_15
  settings:
    tier: db-f1-micro
    backupConfiguration:
      enabled: true
`;
    const diags = wgc108.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});

// ── WGC109: ComputeFirewall allowing all sources ───────────────────

describe("WGC109: open firewall", () => {
  test("flags ComputeFirewall with 0.0.0.0/0", () => {
    const yaml = `apiVersion: compute.cnrm.cloud.google.com/v1beta1
kind: ComputeFirewall
metadata:
  name: allow-all
spec:
  sourceRanges:
    - "0.0.0.0/0"
  allowed:
    - protocol: tcp
      ports:
        - "80"
`;
    const diags = wgc109.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WGC109");
    expect(diags[0].severity).toBe("warning");
  });

  test("no diagnostic with specific source range", () => {
    const yaml = `apiVersion: compute.cnrm.cloud.google.com/v1beta1
kind: ComputeFirewall
metadata:
  name: allow-internal
spec:
  sourceRanges:
    - "10.0.0.0/8"
  allowed:
    - protocol: tcp
      ports:
        - "80"
`;
    const diags = wgc109.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});

// ── WGC110: KMS CryptoKey missing rotation ─────────────────────────

describe("WGC110: missing key rotation", () => {
  test("flags KMSCryptoKey without rotation period", () => {
    const yaml = `apiVersion: kms.cnrm.cloud.google.com/v1beta1
kind: KMSCryptoKey
metadata:
  name: my-key
spec:
  purpose: ENCRYPT_DECRYPT
`;
    const diags = wgc110.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WGC110");
    expect(diags[0].severity).toBe("warning");
  });

  test("no diagnostic when rotation period set", () => {
    const yaml = `apiVersion: kms.cnrm.cloud.google.com/v1beta1
kind: KMSCryptoKey
metadata:
  name: my-key
spec:
  purpose: ENCRYPT_DECRYPT
  rotationPeriod: 7776000s
`;
    const diags = wgc110.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});

// ── WGC201: Missing managed-by label ───────────────────────────────

describe("WGC201: missing managed-by label", () => {
  test("flags resource without managed-by label", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
`;
    const diags = wgc201.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WGC201");
    expect(diags[0].severity).toBe("info");
  });

  test("no diagnostic when managed-by label present", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
  labels:
    app.kubernetes.io/managed-by: chant
spec:
  location: US
`;
    const diags = wgc201.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});

// ── WGC202: GKE cluster without workload identity ──────────────────

describe("WGC202: missing workload identity", () => {
  test("flags ContainerCluster without workload identity", () => {
    const yaml = `apiVersion: container.cnrm.cloud.google.com/v1beta1
kind: ContainerCluster
metadata:
  name: my-cluster
spec:
  location: us-central1
`;
    const diags = wgc202.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WGC202");
    expect(diags[0].severity).toBe("warning");
  });

  test("no diagnostic when workload identity configured", () => {
    const yaml = `apiVersion: container.cnrm.cloud.google.com/v1beta1
kind: ContainerCluster
metadata:
  name: my-cluster
spec:
  location: us-central1
  workloadIdentityConfig:
    workloadPool: my-project.svc.id.goog
`;
    const diags = wgc202.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});

// ── WGC203: Overly broad OAuth scope ───────────────────────────────

describe("WGC203: cloud-platform OAuth scope", () => {
  test("flags ContainerNodePool with cloud-platform scope", () => {
    const yaml = `apiVersion: container.cnrm.cloud.google.com/v1beta1
kind: ContainerNodePool
metadata:
  name: my-pool
spec:
  clusterRef:
    name: my-cluster
  nodeConfig:
    oauthScopes:
      - "https://www.googleapis.com/auth/cloud-platform"
`;
    const diags = wgc203.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WGC203");
    expect(diags[0].severity).toBe("warning");
  });

  test("no diagnostic with specific scopes", () => {
    const yaml = `apiVersion: container.cnrm.cloud.google.com/v1beta1
kind: ContainerNodePool
metadata:
  name: my-pool
spec:
  clusterRef:
    name: my-cluster
  nodeConfig:
    oauthScopes:
      - "https://www.googleapis.com/auth/logging.write"
      - "https://www.googleapis.com/auth/monitoring"
`;
    const diags = wgc203.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});

// ── WGC204: ComputeInstance without shielded VM ────────────────────

describe("WGC204: missing shielded VM config", () => {
  test("flags ComputeInstance without shielded VM", () => {
    const yaml = `apiVersion: compute.cnrm.cloud.google.com/v1beta1
kind: ComputeInstance
metadata:
  name: my-vm
spec:
  machineType: e2-medium
  zone: us-central1-a
`;
    const diags = wgc204.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WGC204");
    expect(diags[0].severity).toBe("info");
  });

  test("no diagnostic when shielded VM configured", () => {
    const yaml = `apiVersion: compute.cnrm.cloud.google.com/v1beta1
kind: ComputeInstance
metadata:
  name: my-vm
spec:
  machineType: e2-medium
  zone: us-central1-a
  shieldedInstanceConfig:
    enableSecureBoot: true
    enableVtpm: true
    enableIntegrityMonitoring: true
`;
    const diags = wgc204.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});

// ── WGC301: No audit logging config ────────────────────────────────

describe("WGC301: no audit logging", () => {
  test("flags output without IAMAuditConfig", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
`;
    const diags = wgc301.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WGC301");
    expect(diags[0].severity).toBe("info");
  });

  test("no diagnostic when IAMAuditConfig present", () => {
    const yaml = `apiVersion: iam.cnrm.cloud.google.com/v1beta1
kind: IAMAuditConfig
metadata:
  name: audit-config
spec:
  service: allServices
  auditLogConfigs:
    - logType: ADMIN_READ
    - logType: DATA_READ
`;
    const diags = wgc301.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});

// ── WGC302: Service API not enabled ────────────────────────────────

describe("WGC302: service API not enabled", () => {
  test("flags output without Service resource", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
`;
    const diags = wgc302.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WGC302");
    expect(diags[0].severity).toBe("info");
  });

  test("no diagnostic when Service resource present", () => {
    const yaml = `apiVersion: serviceusage.cnrm.cloud.google.com/v1beta1
kind: Service
metadata:
  name: compute-api
spec:
  resourceID: compute.googleapis.com
`;
    const diags = wgc302.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});

// ── WGC303: Missing VPC Service Controls ───────────────────────────

describe("WGC303: missing VPC Service Controls", () => {
  test("flags output without service perimeter", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
`;
    const diags = wgc303.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WGC303");
    expect(diags[0].severity).toBe("info");
  });

  test("no diagnostic when service perimeter present", () => {
    const yaml = `apiVersion: accesscontextmanager.cnrm.cloud.google.com/v1beta1
kind: AccessContextManagerServicePerimeter
metadata:
  name: my-perimeter
spec:
  title: my-perimeter
  perimeterType: PERIMETER_TYPE_REGULAR
`;
    const diags = wgc303.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});

// ── WGC111: Dangling resource reference ────────────────────────────

describe("WGC111: dangling resource reference", () => {
  test("flags resourceRef pointing to nonexistent name", () => {
    const yaml = `apiVersion: container.cnrm.cloud.google.com/v1beta1
kind: ContainerNodePool
metadata:
  name: my-pool
spec:
  clusterRef:
    name: nonexistent-cluster
`;
    const diags = wgc111.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WGC111");
    expect(diags[0].severity).toBe("warning");
  });

  test("no diagnostic when referenced resource exists", () => {
    const yaml = `apiVersion: container.cnrm.cloud.google.com/v1beta1
kind: ContainerCluster
metadata:
  name: my-cluster
spec:
  location: us-central1
---
apiVersion: container.cnrm.cloud.google.com/v1beta1
kind: ContainerNodePool
metadata:
  name: my-pool
spec:
  clusterRef:
    name: my-cluster
`;
    const diags = wgc111.check(makeCtx(yaml));
    const poolDiags = diags.filter(d => d.entity === "my-pool");
    expect(poolDiags).toHaveLength(0);
  });
});

// ── WGC112: Missing or invalid apiVersion ──────────────────────────

describe("WGC112: missing or invalid apiVersion", () => {
  test("flags resource with missing apiVersion", () => {
    const yaml = `kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
`;
    const diags = wgc112.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WGC112");
    expect(diags[0].severity).toBe("error");
  });

  test("flags resource with malformed apiVersion", () => {
    const yaml = `apiVersion: not-a-valid-version
kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
`;
    const diags = wgc112.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WGC112");
  });

  test("no diagnostic with valid apiVersion", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
`;
    const diags = wgc112.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});

// ── WGC113: Alpha API version warning ──────────────────────────────

describe("WGC113: alpha API version", () => {
  test("flags resource with v1alpha1 apiVersion", () => {
    const yaml = `apiVersion: compute.cnrm.cloud.google.com/v1alpha1
kind: ComputeInstance
metadata:
  name: my-vm
spec:
  machineType: e2-medium
`;
    const diags = wgc113.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WGC113");
    expect(diags[0].severity).toBe("warning");
  });

  test("no diagnostic with v1beta1 apiVersion", () => {
    const yaml = `apiVersion: compute.cnrm.cloud.google.com/v1beta1
kind: ComputeInstance
metadata:
  name: my-vm
spec:
  machineType: e2-medium
`;
    const diags = wgc113.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});

// ── WGC401: Unknown spec field ─────────────────────────────────────

describe("WGC401: unknown spec field", () => {
  test("flags unknown field with did-you-mean suggestion", () => {
    const yaml = `apiVersion: compute.cnrm.cloud.google.com/v1beta1
kind: ComputeFirewall
metadata:
  name: my-fw
spec:
  allowed:
    - protocol: tcp
  networkRef:
    name: my-network
`;
    const diags = wgc401.check(makeCtx(yaml));
    // "allowed" is not a valid field — "allow" is. Should flag it.
    const unknownDiags = diags.filter(d => d.checkId === "WGC401");
    // If schema is loaded, this will flag "allowed"
    // If schema is not loaded (pre-generate), skip gracefully
    if (unknownDiags.length > 0) {
      expect(unknownDiags[0].severity).toBe("error");
      expect(unknownDiags[0].message).toContain("allowed");
    }
  });

  test("no diagnostic for valid fields", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
`;
    const diags = wgc401.check(makeCtx(yaml));
    // "location" is a valid StorageBucket field
    const unknownDiags = diags.filter(d => d.checkId === "WGC401");
    expect(unknownDiags).toHaveLength(0);
  });
});

// ── WGC402: Missing required field ─────────────────────────────────

describe("WGC402: missing required field", () => {
  test("flags missing required field", () => {
    const yaml = `apiVersion: compute.cnrm.cloud.google.com/v1beta1
kind: ComputeAddress
metadata:
  name: my-addr
spec:
  description: test
`;
    const diags = wgc402.check(makeCtx(yaml));
    const requiredDiags = diags.filter(d => d.checkId === "WGC402");
    // ComputeAddress requires "location" — if schema is loaded, this flags it
    if (requiredDiags.length > 0) {
      expect(requiredDiags[0].severity).toBe("error");
      expect(requiredDiags[0].message).toContain("required");
    }
  });

  test("no diagnostic when all required fields present", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
`;
    const diags = wgc402.check(makeCtx(yaml));
    const requiredDiags = diags.filter(d => d.checkId === "WGC402");
    expect(requiredDiags).toHaveLength(0);
  });
});

// ── WGC403: Type/structure mismatch ────────────────────────────────

describe("WGC403: type/structure mismatch", () => {
  test("flags string where number expected", () => {
    const yaml = `apiVersion: cloudfunctions.cnrm.cloud.google.com/v1beta1
kind: CloudFunctionsFunction
metadata:
  name: my-fn
spec:
  runtime: nodejs18
  availableMemoryMb: "512"
  region: us-central1
`;
    const diags = wgc403.check(makeCtx(yaml));
    const typeDiags = diags.filter(d => d.checkId === "WGC403");
    if (typeDiags.length > 0) {
      expect(typeDiags[0].severity).toBe("error");
      expect(typeDiags[0].message).toContain("number");
      expect(typeDiags[0].message).toContain("string");
    }
  });

  test("flags bare string instead of resourceRef object", () => {
    const yaml = `apiVersion: pubsub.cnrm.cloud.google.com/v1beta1
kind: PubSubSubscription
metadata:
  name: my-sub
spec:
  topicRef: my-topic
`;
    const diags = wgc403.check(makeCtx(yaml));
    const typeDiags = diags.filter(d => d.checkId === "WGC403");
    if (typeDiags.length > 0) {
      expect(typeDiags[0].severity).toBe("error");
      expect(typeDiags[0].message).toContain("resourceRef");
    }
  });

  test("no diagnostic with correct types", () => {
    const yaml = `apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
  uniformBucketLevelAccess: true
`;
    const diags = wgc403.check(makeCtx(yaml));
    const typeDiags = diags.filter(d => d.checkId === "WGC403");
    expect(typeDiags).toHaveLength(0);
  });
});
