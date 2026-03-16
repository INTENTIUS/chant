/**
 * WK8304: SSL Redirect Without Certificate
 *
 * Flags Ingress resources that have `alb.ingress.kubernetes.io/ssl-redirect`
 * annotation set but are missing `alb.ingress.kubernetes.io/certificate-arn`
 * or don't have HTTPS in their listen-ports.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, parseK8sManifests } from "./k8s-helpers";

export const wk8304: PostSynthCheck = {
  id: "WK8304",
  description: "SSL redirect without certificate — ssl-redirect annotation requires a valid certificate-arn and HTTPS listen-ports",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const manifests = parseK8sManifests(yaml);

      for (const manifest of manifests) {
        if (manifest.kind !== "Ingress") continue;

        const annotations = manifest.metadata?.annotations as Record<string, string> | undefined;
        if (!annotations) continue;

        const sslRedirect = annotations["alb.ingress.kubernetes.io/ssl-redirect"];
        if (!sslRedirect) continue;

        const resourceName = manifest.metadata?.name ?? "Ingress";
        const certArn = annotations["alb.ingress.kubernetes.io/certificate-arn"];

        if (!certArn) {
          diagnostics.push({
            checkId: "WK8304",
            severity: "warning",
            message: `Ingress "${resourceName}" has ssl-redirect annotation but no certificate-arn — HTTPS redirect will fail without a TLS certificate`,
            entity: resourceName,
            lexicon: "k8s",
          });
          continue;
        }

        // Check listen-ports includes HTTPS
        const listenPorts = annotations["alb.ingress.kubernetes.io/listen-ports"];
        if (listenPorts) {
          try {
            const ports = JSON.parse(listenPorts) as Array<Record<string, number>>;
            const hasHttps = ports.some((p) => "HTTPS" in p);
            if (!hasHttps) {
              diagnostics.push({
                checkId: "WK8304",
                severity: "warning",
                message: `Ingress "${resourceName}" has ssl-redirect but listen-ports does not include HTTPS`,
                entity: resourceName,
                lexicon: "k8s",
              });
            }
          } catch {
            // Can't parse listen-ports — skip this check
          }
        }
      }
    }

    return diagnostics;
  },
};
