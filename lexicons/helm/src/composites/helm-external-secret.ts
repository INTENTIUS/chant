/**
 * HelmExternalSecret composite — ExternalSecret CR for secret management.
 *
 * Uses the external-secrets.io operator to sync secrets from external
 * providers (AWS Secrets Manager, Vault, etc.) into Kubernetes Secrets.
 *
 * Thanks to the serializer's fallback GVK resolution, this composite
 * returns a plain object with apiVersion/kind and the serializer handles
 * it like any other K8s resource.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { Chart, Values, ExternalSecret } from "../resources";
import { values, include } from "../intrinsics";

export interface HelmExternalSecretProps {
  /** Chart and release name. */
  name: string;
  /** Name of the SecretStore or ClusterSecretStore to reference. */
  secretStoreName: string;
  /** Kind of secret store. Default: "ClusterSecretStore". */
  secretStoreKind?: "SecretStore" | "ClusterSecretStore";
  /** Map of { envVarName: "remote/path" } for secret data. */
  data: Record<string, string>;
  /** Refresh interval. Default: "1h". */
  refreshInterval?: string;
  /** Per-member defaults. */
  defaults?: {
    chart?: Partial<Record<string, unknown>>;
    values?: Partial<Record<string, unknown>>;
    externalSecret?: Partial<Record<string, unknown>>;
  };
}

export interface HelmExternalSecretResult {
  chart: InstanceType<typeof Chart>;
  values: InstanceType<typeof Values>;
  externalSecret: InstanceType<typeof ExternalSecret>;
}

export const HelmExternalSecret = Composite<HelmExternalSecretProps>((props) => {
  const {
    name,
    secretStoreName,
    secretStoreKind = "ClusterSecretStore",
    data,
    refreshInterval = "1h",
    defaults: defs,
  } = props;

  const chart = new Chart(mergeDefaults({
    apiVersion: "v2",
    name,
    version: "0.1.0",
    type: "application",
    description: `External secret management for ${name}`,
  }, defs?.chart));

  const secretDataEntries = Object.entries(data).map(([key, remotePath]) => ({
    secretKey: key,
    remoteRef: {
      key: remotePath,
    },
  }));

  const valuesRes = new Values(mergeDefaults({
    externalSecret: {
      refreshInterval,
      secretStore: {
        name: secretStoreName,
        kind: secretStoreKind,
      },
    },
  } as Record<string, unknown>, defs?.values));

  const externalSecret = new ExternalSecret(mergeDefaults({
    apiVersion: "external-secrets.io/v1beta1",
    kind: "ExternalSecret",
    metadata: {
      name: include(`${name}.fullname`),
      labels: include(`${name}.labels`),
    },
    spec: {
      refreshInterval: values.externalSecret.refreshInterval,
      secretStoreRef: {
        name: values.externalSecret.secretStore.name,
        kind: values.externalSecret.secretStore.kind,
      },
      target: {
        name: include(`${name}.fullname`),
        creationPolicy: "Owner",
      },
      data: secretDataEntries,
    },
  }, defs?.externalSecret));

  return {
    chart,
    values: valuesRes,
    externalSecret,
  };
}, "HelmExternalSecret");
