/**
 * WAW049: Security Group Broad Ingress (any port, except ALB:80/443)
 *
 * Generalizes WAW019 beyond the four named sensitive ports (SSH/RDP/MySQL/
 * Postgres): flags 0.0.0.0/0 or ::/0 ingress on *any* port, with a carve-out
 * for the conventional public ALB listener ports (exactly 80 or 443).
 *
 * Port 80 is exempt unconditionally, not just on a relaxed tier (#917): a
 * public ALB's HTTP listener is meant to be internet-facing on every tier —
 * on the full/production tier it still needs an SG rule open to 0.0.0.0/0 so
 * clients can reach the listener that redirects them to HTTPS (WAW044 is the
 * rule that enforces the redirect actually happens; this rule only judges the
 * SG's shape). The "light" tier serves plaintext HTTP straight off that same
 * port instead of redirecting, which doesn't change the SG's exposure at all.
 * A genuinely over-broad rule (all ports, SSH, etc.) still errors regardless
 * of tier.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate, getSecurityGroupIngress, isIntrinsic } from "./cf-refs";

const OPEN_CIDRS = new Set(["0.0.0.0/0", "::/0"]);
const ALB_LISTENER_PORTS = new Set([80, 443]);

function isAlbListenerException(rule: Record<string, unknown>): boolean {
  return (
    typeof rule.FromPort === "number" &&
    rule.FromPort === rule.ToPort &&
    ALB_LISTENER_PORTS.has(rule.FromPort)
  );
}

function checkIngressRule(
  rule: Record<string, unknown>,
  logicalId: string,
  diagnostics: PostSynthDiagnostic[],
): void {
  const cidrIp = rule.CidrIp;
  const cidrIpv6 = rule.CidrIpv6;

  const hasOpenCidr =
    (typeof cidrIp === "string" && OPEN_CIDRS.has(cidrIp)) ||
    (typeof cidrIpv6 === "string" && OPEN_CIDRS.has(cidrIpv6));

  if (!hasOpenCidr) return;

  // Can't statically verify a port pinned by an intrinsic — don't guess.
  if (isIntrinsic(rule.FromPort) || isIntrinsic(rule.ToPort)) return;

  if (isAlbListenerException(rule)) return;

  const cidr = typeof cidrIp === "string" && OPEN_CIDRS.has(cidrIp) ? cidrIp : cidrIpv6;
  const fromPort = rule.FromPort;
  const toPort = rule.ToPort;
  const portDesc =
    fromPort !== undefined && toPort !== undefined ? ` on ports ${fromPort}-${toPort}` : " on all ports";

  diagnostics.push({
    checkId: "WAW049",
    severity: "error",
    message: `Security group "${logicalId}" allows unrestricted ingress from ${cidr}${portDesc} — restrict to specific CIDR ranges (only ALB:80/443 is exempt)`,
    entity: logicalId,
    lexicon: "aws",
  });
}

export function checkBroadIngress(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      if (resource.Type === "AWS::EC2::SecurityGroup") {
        for (const rule of getSecurityGroupIngress(resource)) {
          checkIngressRule(rule, logicalId, diagnostics);
        }
      }

      if (resource.Type === "AWS::EC2::SecurityGroupIngress") {
        const props = resource.Properties ?? {};
        if (!isIntrinsic(props)) {
          checkIngressRule(props as Record<string, unknown>, logicalId, diagnostics);
        }
      }
    }
  }

  return diagnostics;
}

export const waw049: PostSynthCheck = {
  id: "WAW049",
  description: "Security group allows unrestricted ingress on a port other than ALB:80/443",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkBroadIngress(ctx);
  },
};
