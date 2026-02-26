/**
 * HelmNamespaceEnv composite — Namespace + ResourceQuota + LimitRange + NetworkPolicy.
 *
 * Environment namespace pattern with optional resource governance and
 * network isolation.
 */

import { values, include, toYaml, If } from "../intrinsics";

export interface HelmNamespaceEnvProps {
  /** Chart and release name. */
  name: string;
  /** Include ResourceQuota. Default: true. */
  resourceQuota?: boolean;
  /** Include LimitRange. Default: true. */
  limitRange?: boolean;
  /** Include NetworkPolicy. Default: true. */
  networkPolicy?: boolean;
  /** Chart appVersion. */
  appVersion?: string;
}

export interface HelmNamespaceEnvResult {
  chart: Record<string, unknown>;
  values: Record<string, unknown>;
  namespace: Record<string, unknown>;
  resourceQuota?: Record<string, unknown>;
  limitRange?: Record<string, unknown>;
  networkPolicy?: Record<string, unknown>;
}

export function HelmNamespaceEnv(props: HelmNamespaceEnvProps): HelmNamespaceEnvResult {
  const {
    name,
    resourceQuota = true,
    limitRange = true,
    networkPolicy = true,
    appVersion = "1.0.0",
  } = props;

  const chart = {
    apiVersion: "v2",
    name,
    version: "0.1.0",
    appVersion,
    type: "application",
    description: `A Helm chart for ${name} namespace environment`,
  };

  const valuesObj: Record<string, unknown> = {
    namespace: {
      labels: {},
      annotations: {},
    },
  };

  if (resourceQuota) {
    valuesObj.resourceQuota = {
      enabled: true,
      hard: {
        cpu: "10",
        memory: "20Gi",
        pods: "50",
      },
    };
  }

  if (limitRange) {
    valuesObj.limitRange = {
      enabled: true,
      default: {
        cpu: "500m",
        memory: "256Mi",
      },
      defaultRequest: {
        cpu: "100m",
        memory: "128Mi",
      },
    };
  }

  if (networkPolicy) {
    valuesObj.networkPolicy = {
      enabled: true,
      denyIngress: true,
      denyEgress: false,
    };
  }

  const ns = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: include(`${name}.fullname`),
      labels: toYaml(values.namespace.labels),
      annotations: toYaml(values.namespace.annotations),
    },
  };

  const result: HelmNamespaceEnvResult = {
    chart,
    values: valuesObj,
    namespace: ns,
  };

  if (resourceQuota) {
    result.resourceQuota = If(values.resourceQuota.enabled, {
      apiVersion: "v1",
      kind: "ResourceQuota",
      metadata: {
        name: include(`${name}.fullname`),
        labels: include(`${name}.labels`),
      },
      spec: {
        hard: toYaml(values.resourceQuota.hard),
      },
    }) as unknown as Record<string, unknown>;
  }

  if (limitRange) {
    result.limitRange = If(values.limitRange.enabled, {
      apiVersion: "v1",
      kind: "LimitRange",
      metadata: {
        name: include(`${name}.fullname`),
        labels: include(`${name}.labels`),
      },
      spec: {
        limits: [{
          type: "Container",
          default: toYaml(values.limitRange.default),
          defaultRequest: toYaml(values.limitRange.defaultRequest),
        }],
      },
    }) as unknown as Record<string, unknown>;
  }

  if (networkPolicy) {
    result.networkPolicy = If(values.networkPolicy.enabled, {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: {
        name: include(`${name}.fullname`),
        labels: include(`${name}.labels`),
      },
      spec: {
        podSelector: {},
        policyTypes: ["Ingress", "Egress"],
      },
    }) as unknown as Record<string, unknown>;
  }

  return result;
}
