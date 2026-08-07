/**
 * StatefulService — a stateful workload with its volume set, mounted.
 *
 * Persistent storage on Control Plane is two resources that have to agree, and
 * the ways they can disagree are all expensive:
 *
 * - `ext4` and `xfs` volume sets bind to exactly one *stateful* workload.
 *   Mounting one from a serverless or standard workload is not a degraded
 *   mode, it is rejected.
 * - `fileSystemType` and `performanceClass` are both immutable. Changing
 *   either later means delete and recreate, which means data loss.
 * - `high-throughput-ssd` has a 200 GB floor, not the 10 GB floor the other
 *   classes have, so an initial capacity that is fine for one class is invalid
 *   for another.
 * - A volume set is GVC-scoped and only mountable from its own GVC.
 *
 * This composite pairs them so the mount URI, the GVC and the workload type
 * cannot drift apart, and validates the capacity floor at build time rather
 * than at apply time.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { Workload, VolumeSet } from "../generated";

/** Minimum initial capacity in GB, by performance class. */
const MIN_CAPACITY_GB: Record<string, number> = {
  "general-purpose-ssd": 10,
  "high-throughput-ssd": 200,
  shared: 10,
};

export interface StatefulServiceProps {
  /** Workload name. The volume set is named `<name>-data` unless overridden. */
  name: string;
  /** GVC for both the workload and the volume set. */
  gvc: string;
  /** Container image. */
  image: string;
  /** Mount path inside the container. */
  mountPath: string;
  /** Initial volume capacity in GB. Must clear the performance class floor. */
  capacityGb: number;
  /** Volume set name (default `<name>-data`). */
  volumeSetName?: string;
  /** Filesystem (default `ext4`). Immutable after creation. */
  fileSystemType?: "ext4" | "xfs" | "shared";
  /** Performance class (default `general-purpose-ssd`). Immutable after creation. */
  performanceClass?: "general-purpose-ssd" | "high-throughput-ssd" | "shared";
  /**
   * What happens to the volume when the workload releases it (default
   * `retain`). `recycle` discards the data.
   */
  recoveryPolicy?: "retain" | "recycle";
  /** Ports the container exposes. */
  ports?: Array<{ number: number; protocol?: "http" | "http2" | "grpc" | "tcp" }>;
  /** Container name (default `main`). */
  containerName?: string;
  /** CPU in millicores (default `50m`). */
  cpu?: string;
  /** Memory (default `128Mi`). */
  memory?: string;
  /** Environment variables, as a plain map. */
  env?: Record<string, string>;
  /** CIDRs allowed to reach the workload from the internet. Defaults to closed. */
  inboundAllowCidr?: string[];
  /** Hostnames or CIDRs the workload may call out to. Defaults to closed. */
  outboundAllowCidr?: string[];
  /** Minimum replicas (default 1). Stateful cannot scale to zero without KEDA. */
  minScale?: number;
  /** Maximum replicas (default 1). */
  maxScale?: number;
  /** Identity to run as, as a link (`//gvc/GVC/identity/NAME`). */
  identityLink?: string;
  /** Tags applied to both resources. */
  tags?: Record<string, string>;
  /** Per-member defaults for customizing individual resources. */
  defaults?: {
    workload?: Partial<ConstructorParameters<typeof Workload>[0]>;
    volumeSet?: Partial<ConstructorParameters<typeof VolumeSet>[0]>;
  };
}

export const StatefulService = Composite((props: StatefulServiceProps) => {
  const {
    name,
    gvc,
    image,
    mountPath,
    capacityGb,
    volumeSetName = `${name}-data`,
    fileSystemType = "ext4",
    performanceClass = "general-purpose-ssd",
    recoveryPolicy = "retain",
    ports = [],
    containerName = "main",
    cpu = "50m",
    memory = "128Mi",
    env,
    inboundAllowCidr = [],
    outboundAllowCidr = [],
    minScale = 1,
    maxScale = 1,
    identityLink,
    tags,
    defaults: defs,
  } = props;

  const floor = MIN_CAPACITY_GB[performanceClass];
  if (floor !== undefined && capacityGb < floor) {
    throw new Error(
      `StatefulService "${name}": capacityGb ${capacityGb} is below the ${floor} GB minimum for ` +
        `performanceClass "${performanceClass}". Both fileSystemType and performanceClass are immutable ` +
        `after creation, so this is worth getting right before the first apply.`,
    );
  }

  const volumeSet = new VolumeSet(
    mergeDefaults(
      {
        name: volumeSetName,
        gvc,
        ...(tags && { tags }),
        spec: {
          initialCapacity: capacityGb,
          fileSystemType,
          // Control Plane forces `shared` for a shared filesystem; setting it
          // explicitly keeps the emitted manifest equal to what comes back.
          performanceClass: fileSystemType === "shared" ? "shared" : performanceClass,
          snapshots: { createFinalSnapshot: true },
        },
      } as Record<string, unknown>,
      defs?.volumeSet,
    ),
  );

  const workload = new Workload(
    mergeDefaults(
      {
        name,
        gvc,
        ...(tags && { tags }),
        spec: {
          type: "stateful",
          ...(identityLink && { identityLink }),
          containers: [
            {
              name: containerName,
              image,
              cpu,
              memory,
              ...(ports.length > 0 && {
                ports: ports.map((p) => ({ number: p.number, protocol: p.protocol ?? "http" })),
              }),
              ...(env && {
                env: Object.entries(env).map(([envName, value]) => ({ name: envName, value })),
              }),
              volumes: [
                {
                  uri: `cpln://volumeset/${volumeSetName}`,
                  path: mountPath,
                  recoveryPolicy,
                },
              ],
            },
          ],
          firewallConfig: {
            external: { inboundAllowCIDR: inboundAllowCidr, outboundAllowCIDR: outboundAllowCidr },
          },
          defaultOptions: {
            autoscaling: { minScale, maxScale },
          },
        },
      } as Record<string, unknown>,
      defs?.workload,
    ),
  );

  return { workload, volumeSet };
}, "StatefulService");
