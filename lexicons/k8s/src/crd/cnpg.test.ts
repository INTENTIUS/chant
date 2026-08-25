/**
 * CNPG acceptance test.
 *
 * The bar set by #1319 is that fountain's real `k8s/` overlay — postgres.yaml,
 * scheduledbackup.yaml, objectstore.yaml — is reproducible from typed chant
 * source. So these assertions are transcribed from that overlay rather than
 * from a fixture invented to pass, and every value here is one a running
 * cluster has.
 */

import { describe, test, expect } from "vitest";
// chant #10 — CAPI's own `Cluster` kind (K8s::CAPI::Cluster) collides with
// CNPG's `Cluster` (K8s::Cnpg::Cluster) on the bare class name, so codegen's
// disambiguation now exports this one as `CnpgCluster`. The generated
// resource type name (K8s::Cnpg::Cluster) and the serialized `kind: Cluster`
// are unaffected — only the TS identifier changed.
import { CnpgCluster, ScheduledBackup, ObjectStore } from "../generated";
import { k8sSerializer } from "../serializer";
import { parseYAML } from "@intentius/chant/yaml";

/** Serialize one declaration the way `chant build` would, and read it back. */
function synth(logicalName: string, resource: unknown): any {
  const yaml = k8sSerializer.serialize(new Map([[logicalName, resource as never]])) as string;
  return parseYAML(yaml);
}

describe("CNPG Cluster", () => {
  const cluster = new CnpgCluster({
    metadata: { name: "fountain-pg", namespace: "fountain", labels: { app: "fountain" } },
    spec: {
      instances: 1,
      imageName: "ghcr.io/cloudnative-pg/postgresql:18.4-standard-trixie",
      plugins: [
        {
          name: "barman-cloud.cloudnative-pg.io",
          isWALArchiver: true,
          parameters: { barmanObjectName: "fountain-backups" },
        },
      ],
      bootstrap: {
        initdb: {
          database: "fountain",
          owner: "fountain",
          postInitTemplateSQL: ["CREATE EXTENSION IF NOT EXISTS vector;"],
        },
      },
      storage: { storageClass: "longhorn", size: "10Gi" },
      resources: {
        requests: { cpu: "100m", memory: "512Mi" },
        limits: { memory: "1Gi" },
      },
    },
  });

  test("carries the CNPG apiVersion and kind", () => {
    const doc = synth("fountainPg", cluster);
    expect(doc.apiVersion).toBe("postgresql.cnpg.io/v1");
    expect(doc.kind).toBe("Cluster");
    expect(doc.metadata.name).toBe("fountain-pg");
    expect(doc.metadata.namespace).toBe("fountain");
  });

  test("reproduces fountain's postgres.yaml spec", () => {
    const { spec } = synth("fountainPg", cluster);
    expect(spec.instances).toBe(1);
    expect(spec.imageName).toBe("ghcr.io/cloudnative-pg/postgresql:18.4-standard-trixie");
    expect(spec.storage).toEqual({ storageClass: "longhorn", size: "10Gi" });
    expect(spec.bootstrap.initdb.database).toBe("fountain");
    expect(spec.bootstrap.initdb.owner).toBe("fountain");
    expect(spec.bootstrap.initdb.postInitTemplateSQL).toEqual([
      "CREATE EXTENSION IF NOT EXISTS vector;",
    ]);
    // A memory limit with no CPU limit is deliberate upstream: a CPU limit
    // throttles a database. It has to survive serialization as written.
    expect(spec.resources).toEqual({
      requests: { cpu: "100m", memory: "512Mi" },
      limits: { memory: "1Gi" },
    });
  });

  test("wires WAL archiving to the ObjectStore by name", () => {
    const { spec } = synth("fountainPg", cluster);
    // This block is the whole link between the two CRDs. `isWALArchiver` must
    // stay a boolean -- quoted, the plugin ignores it and archiving is silently
    // off, which looks exactly like a healthy cluster until a restore.
    expect(spec.plugins).toEqual([
      {
        name: "barman-cloud.cloudnative-pg.io",
        isWALArchiver: true,
        parameters: { barmanObjectName: "fountain-backups" },
      },
    ]);
    expect(typeof spec.plugins[0].isWALArchiver).toBe("boolean");
  });
});

describe("CNPG ScheduledBackup", () => {
  const backup = new ScheduledBackup({
    metadata: { name: "fountain-pg-base", namespace: "fountain", labels: { app: "fountain" } },
    spec: {
      schedule: "0 47 2 * * *",
      backupOwnerReference: "self",
      cluster: { name: "fountain-pg" },
      method: "plugin",
      pluginConfiguration: { name: "barman-cloud.cloudnative-pg.io" },
    },
  });

  test("reproduces fountain's scheduledbackup.yaml", () => {
    const doc = synth("fountainPgBase", backup);
    expect(doc.apiVersion).toBe("postgresql.cnpg.io/v1");
    expect(doc.kind).toBe("ScheduledBackup");
    expect(doc.spec.backupOwnerReference).toBe("self");
    expect(doc.spec.cluster).toEqual({ name: "fountain-pg" });
    expect(doc.spec.method).toBe("plugin");
    expect(doc.spec.pluginConfiguration).toEqual({ name: "barman-cloud.cloudnative-pg.io" });
  });

  test("round-trips a six-field schedule", () => {
    const { spec } = synth("fountainPgBase", backup);
    // CNPG schedules lead with seconds, so this is six fields where a
    // Kubernetes CronJob takes five. The schema types it as a plain string, so
    // nothing here or upstream rejects the five-field form -- it just means a
    // different time. The count is the only thing that catches it.
    expect(spec.schedule).toBe("0 47 2 * * *");
    expect(spec.schedule.trim().split(/\s+/)).toHaveLength(6);
  });
});

describe("barman-cloud ObjectStore", () => {
  const store = new ObjectStore({
    metadata: { name: "fountain-backups", namespace: "fountain", labels: { app: "fountain" } },
    spec: {
      retentionPolicy: "14d",
      configuration: {
        destinationPath: "s3://fountain-backups/barman",
        endpointURL: "http://s3.garage.svc.cluster.local:3900",
        s3Credentials: {
          accessKeyId: { name: "fountain-backup-s3-credentials", key: "AWS_ACCESS_KEY_ID" },
          secretAccessKey: { name: "fountain-backup-s3-credentials", key: "AWS_SECRET_ACCESS_KEY" },
        },
        wal: { compression: "gzip" },
        data: { compression: "gzip" },
      },
    },
  });

  test("reproduces fountain's objectstore.yaml", () => {
    const doc = synth("fountainBackups", store);
    // Its own group, mapped onto the same `Cnpg` namespace as the Cluster.
    expect(doc.apiVersion).toBe("barmancloud.cnpg.io/v1");
    expect(doc.kind).toBe("ObjectStore");
    expect(doc.spec.retentionPolicy).toBe("14d");
    expect(doc.spec.configuration.destinationPath).toBe("s3://fountain-backups/barman");
    expect(doc.spec.configuration.endpointURL).toBe("http://s3.garage.svc.cluster.local:3900");
    expect(doc.spec.configuration.wal).toEqual({ compression: "gzip" });
    expect(doc.spec.configuration.data).toEqual({ compression: "gzip" });
  });

  test("keeps credentials as secret references, never values", () => {
    const { spec } = synth("fountainBackups", store);
    expect(spec.configuration.s3Credentials).toEqual({
      accessKeyId: { name: "fountain-backup-s3-credentials", key: "AWS_ACCESS_KEY_ID" },
      secretAccessKey: { name: "fountain-backup-s3-credentials", key: "AWS_SECRET_ACCESS_KEY" },
    });
  });

  test("the Cluster's barmanObjectName matches this store's name", () => {
    // The two CRDs are joined by a string. Nothing upstream checks it: a typo
    // leaves the cluster running with archiving pointed at a store that does
    // not exist.
    const clusterDoc = synth(
      "fountainPg",
      new CnpgCluster({
        metadata: { name: "fountain-pg", namespace: "fountain" },
        spec: {
          instances: 1,
          plugins: [
            {
              name: "barman-cloud.cloudnative-pg.io",
              isWALArchiver: true,
              parameters: { barmanObjectName: "fountain-backups" },
            },
          ],
        },
      }),
    );
    const storeDoc = synth("fountainBackups", store);
    expect(clusterDoc.spec.plugins[0].parameters.barmanObjectName).toBe(storeDoc.metadata.name);
  });
});
