/**
 * GvcEnvironment — a GVC placed in named locations, with its pull secrets.
 *
 * Two things belong here rather than at the workload:
 *
 * - **Pull secrets are GVC-level** (`spec.pullSecretLinks`), not per-workload.
 *   Looking for them on a workload is a common wrong turn, and only the
 *   `docker`, `ecr` and `gcp` secret types are valid as pull secrets.
 * - **Placement is GVC-level.** Location links use the full org-qualified path
 *   (`/org/ORG/location/aws-us-east-1`), which is why this takes an `org`.
 *
 * The location id format is `<provider>-<region>`: `aws-us-east-1`,
 * `gcp-us-central1`, `azure-eastus`.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { Gvc } from "../generated";

/** Location ids look like `aws-us-east-1`, `gcp-us-central1`, `azure-eastus`. */
const LOCATION_ID = /^(aws|gcp|azure)-[a-z0-9-]+$/;

export interface GvcEnvironmentProps {
  /** GVC name. */
  name: string;
  /** Org the GVC belongs to. Needed to build location links. */
  org: string;
  /** Location ids to place workloads in, e.g. `["aws-us-east-1"]`. */
  locations: string[];
  /**
   * Names of secrets used to pull private images. Only `docker`, `ecr` and
   * `gcp` secret types are valid here.
   */
  pullSecrets?: string[];
  /**
   * Public endpoint naming scheme (default `org`, the default for new GVCs):
   * `{workload}-{gvcAlias}.{orgPrefix}.cpln.app`.
   */
  endpointNamingFormat?: "default" | "legacy" | "org";
  /** Environment variables inherited by every workload in the GVC. */
  env?: Record<string, string>;
  /** Enable KEDA autoscaling for standard and stateful workloads in this GVC. */
  keda?: boolean;
  /** Tags applied to the GVC. */
  tags?: Record<string, string>;
  /** Per-member defaults for customizing the underlying resource. */
  defaults?: {
    gvc?: Partial<ConstructorParameters<typeof Gvc>[0]>;
  };
}

export const GvcEnvironment = Composite((props: GvcEnvironmentProps) => {
  const {
    name,
    org,
    locations,
    pullSecrets,
    endpointNamingFormat = "org",
    env,
    keda,
    tags,
    defaults: defs,
  } = props;

  if (locations.length === 0) {
    throw new Error(
      `GvcEnvironment "${name}": no locations. A GVC with no placement accepts workloads and runs them nowhere.`,
    );
  }

  for (const location of locations) {
    if (!LOCATION_ID.test(location)) {
      throw new Error(
        `GvcEnvironment "${name}": "${location}" is not a location id. Expected <provider>-<region>, ` +
          `e.g. "aws-us-east-1", "gcp-us-central1", "azure-eastus".`,
      );
    }
  }

  const gvc = new Gvc(
    mergeDefaults(
      {
        name,
        ...(tags && { tags }),
        spec: {
          endpointNamingFormat,
          staticPlacement: {
            locationLinks: [...locations].sort().map((location) => `/org/${org}/location/${location}`),
          },
          ...(pullSecrets &&
            pullSecrets.length > 0 && {
              pullSecretLinks: [...pullSecrets].sort().map((secret) => `//secret/${secret}`),
            }),
          ...(env && {
            env: Object.entries(env).map(([envName, value]) => ({ name: envName, value })),
          }),
          ...(keda !== undefined && { keda: { enabled: keda } }),
        },
      } as Record<string, unknown>,
      defs?.gvc,
    ),
  );

  return { gvc };
}, "GvcEnvironment");
