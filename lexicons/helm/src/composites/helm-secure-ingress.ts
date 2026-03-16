/**
 * HelmSecureIngress composite — Ingress + optional cert-manager Certificate.
 *
 * TLS-enabled ingress pattern with optional cert-manager integration
 * for automatic certificate provisioning.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { Chart, Values, Ingress, Certificate } from "../resources";
import { values, include, toYaml, If, Range } from "../intrinsics";

export interface HelmSecureIngressProps {
  /** Chart and release name. */
  name: string;
  /** Default ingress class name. */
  ingressClassName?: string;
  /** cert-manager ClusterIssuer name. */
  clusterIssuer?: string;
  /** Chart appVersion. */
  appVersion?: string;
  /** Per-member defaults. */
  defaults?: {
    chart?: Partial<Record<string, unknown>>;
    values?: Partial<Record<string, unknown>>;
    ingress?: Partial<Record<string, unknown>>;
    certificate?: Partial<Record<string, unknown>>;
  };
}

export interface HelmSecureIngressResult {
  chart: InstanceType<typeof Chart>;
  values: InstanceType<typeof Values>;
  ingress: InstanceType<typeof Ingress>;
  certificate?: InstanceType<typeof Certificate>;
}

export const HelmSecureIngress = Composite<HelmSecureIngressProps>((props) => {
  const {
    name,
    ingressClassName = "",
    clusterIssuer = "letsencrypt-prod",
    appVersion = "1.0.0",
    defaults: defs,
  } = props;

  const chart = new Chart(mergeDefaults({
    apiVersion: "v2",
    name,
    version: "0.1.0",
    appVersion,
    type: "application",
    description: `A Helm chart for ${name} secure ingress`,
  }, defs?.chart));

  const valuesRes = new Values(mergeDefaults({
    ingress: {
      enabled: true,
      className: ingressClassName,
      annotations: {},
      hosts: [
        {
          host: `${name}.example.com`,
          paths: [{ path: "/", pathType: "Prefix" }],
        },
      ],
      tls: {
        enabled: true,
        secretName: `${name}-tls`,
      },
    },
    certManager: {
      enabled: true,
      clusterIssuer,
    },
  } as Record<string, unknown>, defs?.values));

  const ingress = new Ingress(mergeDefaults(
    If(values.ingress.enabled, {
      apiVersion: "networking.k8s.io/v1",
      kind: "Ingress",
      metadata: {
        name: include(`${name}.fullname`),
        labels: include(`${name}.labels`),
        annotations: toYaml(values.ingress.annotations),
      },
      spec: {
        ingressClassName: values.ingress.className,
        tls: [{
          secretName: values.ingress.tls.secretName,
          hosts: Range(values.ingress.hosts, values.ingress.hosts),
        }],
        rules: Range(values.ingress.hosts, {
          host: values.ingress.hosts,
          http: {
            paths: values.ingress.hosts,
          },
        }),
      },
    }) as Record<string, unknown>,
    defs?.ingress,
  ));

  // cert-manager Certificate CRD (cert-manager.io/v1)
  const certificate = new Certificate(mergeDefaults(
    If(values.certManager.enabled, {
      apiVersion: "cert-manager.io/v1",
      kind: "Certificate",
      metadata: {
        name: include(`${name}.fullname`),
        labels: include(`${name}.labels`),
      },
      spec: {
        secretName: values.ingress.tls.secretName,
        issuerRef: {
          name: values.certManager.clusterIssuer,
          kind: "ClusterIssuer",
        },
        dnsNames: values.ingress.hosts,
      },
    }) as Record<string, unknown>,
    defs?.certificate,
  ));

  return {
    chart,
    values: valuesRes,
    ingress,
    certificate,
  };
}, "HelmSecureIngress");
