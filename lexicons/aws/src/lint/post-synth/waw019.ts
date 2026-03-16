/**
 * WAW019: Security Group Unrestricted Ingress
 *
 * Flags security groups with 0.0.0.0/0 or ::/0 ingress on sensitive ports
 * (SSH 22, RDP 3389, MySQL 3306, PostgreSQL 5432).
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate, getSecurityGroupIngress, portRangeContainsSensitive, isIntrinsic } from "./cf-refs";

const SENSITIVE_PORTS = [22, 3389, 3306, 5432];
const OPEN_CIDRS = new Set(["0.0.0.0/0", "::/0"]);

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

  if (portRangeContainsSensitive(rule.FromPort, rule.ToPort, SENSITIVE_PORTS)) {
    const cidr = typeof cidrIp === "string" && OPEN_CIDRS.has(cidrIp) ? cidrIp : cidrIpv6;
    const fromPort = rule.FromPort;
    const toPort = rule.ToPort;
    const portDesc = fromPort !== undefined && toPort !== undefined
      ? ` on ports ${fromPort}-${toPort}`
      : " on all ports";

    diagnostics.push({
      checkId: "WAW019",
      severity: "error",
      message: `Security group "${logicalId}" allows unrestricted ingress from ${cidr}${portDesc} — restrict to specific CIDR ranges`,
      entity: logicalId,
      lexicon: "aws",
    });
  }
}

export function checkUnrestrictedIngress(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      // Check inline SecurityGroupIngress on EC2::SecurityGroup
      if (resource.Type === "AWS::EC2::SecurityGroup") {
        const rules = getSecurityGroupIngress(resource);
        for (const rule of rules) {
          checkIngressRule(rule, logicalId, diagnostics);
        }
      }

      // Check standalone SecurityGroupIngress resources
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

export const waw019: PostSynthCheck = {
  id: "WAW019",
  description: "Security group allows unrestricted ingress on sensitive ports (SSH, RDP, database)",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkUnrestrictedIngress(ctx);
  },
};
