/**
 * A stateful Postgres with persistent storage, behind a custom domain.
 *
 * The storage choices here are the ones worth making deliberately:
 * `fileSystemType` and `performanceClass` are both immutable, so changing
 * either after the first apply means delete, recreate, and data loss.
 */

import { GvcEnvironment, StatefulService, PublicDomain, ServerlessService } from "@intentius/chant-lexicon-cpln";

/** The org the location links are built under. Replace it with yours. */
const org = "acme";

export const { gvc } = GvcEnvironment({
  name: "prod",
  org,
  locations: ["aws-us-east-1"],
  // KEDA at the GVC level, so a standard or stateful workload in this GVC can
  // scale on external metrics.
  keda: true,
});

/**
 * `ext4` binds to exactly one stateful workload, which is what a single-writer
 * database wants. `shared` would allow several mounts and support no snapshots.
 */
export const { workload: db, volumeSet } = StatefulService({
  name: "postgres",
  gvc: "prod",
  image: "postgres:17",
  mountPath: "/var/lib/postgresql/data",
  capacityGb: 100,
  fileSystemType: "ext4",
  performanceClass: "general-purpose-ssd",
  ports: [{ number: 5432, protocol: "tcp" }],
  env: { POSTGRES_DB: "app", PGDATA: "/var/lib/postgresql/data/pgdata" },
  minScale: 1,
  maxScale: 1,
});

/** The API in front of it. Reaches the database over the GVC's internal mTLS. */
export const { workload: api } = ServerlessService({
  name: "api",
  gvc: "prod",
  image: "ghcr.io/acme/api:1.4.2",
  port: 8080,
  cpu: "200m",
  memory: "512Mi",
  inboundAllowCidr: ["0.0.0.0/0"],
  env: {
    // Internal DNS inside a GVC. All internal traffic is mTLS-encrypted with
    // no configuration.
    DATABASE_HOST: "postgres.prod.cpln.local",
    DATABASE_PORT: "5432",
  },
});

/**
 * `cname` mode with an `http01` challenge. NS mode would require `dns01`, and
 * an apex domain would require `cname` regardless (CPL030).
 */
export const { domain } = PublicDomain({
  name: "api.example.com",
  gvc: "prod",
  routes: [{ prefix: "/", workload: "api", port: 8080 }],
});
