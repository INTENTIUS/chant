/**
 * HelmNamespaceEnv composite — Namespace + ResourceQuota + LimitRange + NetworkPolicy.
 *
 * Environment namespace pattern with optional resource governance and
 * network isolation.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import {
  Chart, Values, Namespace,
  ResourceQuota as ResourceQuotaRes,
  LimitRange as LimitRangeRes,
  NetworkPolicy as NetworkPolicyRes,
} from "../resources";
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
  /** Per-member defaults. */
  defaults?: {
    chart?: Partial<Record<string, unknown>>;
    values?: Partial<Record<string, unknown>>;
    namespace?: Partial<Record<string, unknown>>;
    resourceQuota?: Partial<Record<string, unknown>>;
    limitRange?: Partial<Record<string, unknown>>;
    networkPolicy?: Partial<Record<string, unknown>>;
  };
}

export interface HelmNamespaceEnvResult {
  chart: InstanceType<typeof Chart>;
  values: InstanceType<typeof Values>;
  namespace: InstanceType<typeof Namespace>;
  resourceQuota?: InstanceType<typeof ResourceQuotaRes>;
  limitRange?: InstanceType<typeof LimitRangeRes>;
  networkPolicy?: InstanceType<typeof NetworkPolicyRes>;
}

export const HelmNamespaceEnv = Composite<HelmNamespaceEnvProps>((props) => {
  const {
    name,
    resourceQuota = true,
    limitRange = true,
    networkPolicy = true,
    appVersion = "1.0.0",
    defaults: defs,
  } = props;

  const chart = new Chart(mergeDefaults({
    apiVersion: "v2",
    name,
    version: "0.1.0",
    appVersion,
    type: "application",
    description: `A Helm chart for ${name} namespace environment`,
  }, defs?.chart));

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

  const valuesRes = new Values(mergeDefaults(valuesObj, defs?.values));

  const ns = new Namespace(mergeDefaults({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: include(`${name}.fullname`),
      labels: toYaml(values.namespace.labels),
      annotations: toYaml(values.namespace.annotations),
    },
  }, defs?.namespace));

  const result: Record<string, any> = {
    chart,
    values: valuesRes,
    namespace: ns,
  };

  if (resourceQuota) {
    result.resourceQuota = new ResourceQuotaRes(mergeDefaults(
      If(values.resourceQuota.enabled, {
        apiVersion: "v1",
        kind: "ResourceQuota",
        metadata: {
          name: include(`${name}.fullname`),
          labels: include(`${name}.labels`),
        },
        spec: {
          hard: toYaml(values.resourceQuota.hard),
        },
      }) as Record<string, unknown>,
      defs?.resourceQuota,
    ));
  }

  if (limitRange) {
    result.limitRange = new LimitRangeRes(mergeDefaults(
      If(values.limitRange.enabled, {
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
      }) as Record<string, unknown>,
      defs?.limitRange,
    ));
  }

  if (networkPolicy) {
    result.networkPolicy = new NetworkPolicyRes(mergeDefaults(
      If(values.networkPolicy.enabled, {
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
      }) as Record<string, unknown>,
      defs?.networkPolicy,
    ));
  }

  return result;
}, "HelmNamespaceEnv");
