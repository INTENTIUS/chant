/**
 * HelmSecureIngress composite — Ingress + optional cert-manager Certificate.
 *
 * TLS-enabled ingress pattern with optional cert-manager integration
 * for automatic certificate provisioning.
 */

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
}

export interface HelmSecureIngressResult {
  chart: Record<string, unknown>;
  values: Record<string, unknown>;
  ingress: Record<string, unknown>;
  certificate?: Record<string, unknown>;
}

export function HelmSecureIngress(props: HelmSecureIngressProps): HelmSecureIngressResult {
  const {
    name,
    ingressClassName = "",
    clusterIssuer = "letsencrypt-prod",
    appVersion = "1.0.0",
  } = props;

  const chart = {
    apiVersion: "v2",
    name,
    version: "0.1.0",
    appVersion,
    type: "application",
    description: `A Helm chart for ${name} secure ingress`,
  };

  const valuesObj: Record<string, unknown> = {
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
  };

  const ingress = If(values.ingress.enabled, {
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
  });

  // cert-manager Certificate CRD (cert-manager.io/v1)
  const certificate = If(values.certManager.enabled, {
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
  });

  return {
    chart,
    values: valuesObj,
    ingress: ingress as unknown as Record<string, unknown>,
    certificate: certificate as unknown as Record<string, unknown>,
  };
}
