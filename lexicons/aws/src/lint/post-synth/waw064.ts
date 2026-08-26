/**
 * WAW064: Transit Gateway Route Table Declares A Blackhole Route
 *
 * `AWS::EC2::TransitGatewayRoute` with `Blackhole: true` silently drops any
 * traffic matching its destination CIDR instead of forwarding it —
 * CloudFormation deploys this without complaint, and the packet loss only
 * surfaces downstream as unreachable hosts or a timeout nobody can explain
 * from the template alone. A blackhole route is sometimes deliberate — an
 * explicit deny for a CIDR range, or a placeholder pending real
 * infrastructure — but it is also exactly what a copy-pasted route table or
 * a forgotten cleanup step leaves behind. Warn so it stays a conscious
 * choice rather than a silent accident.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate } from "./cf-refs";

export function checkTgwBlackholeRoute(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      if (resource.Type !== "AWS::EC2::TransitGatewayRoute") continue;

      const props = resource.Properties ?? {};
      if (props.Blackhole !== true) continue;

      const cidr = typeof props.DestinationCidrBlock === "string" ? props.DestinationCidrBlock : "(unknown destination)";
      diagnostics.push({
        checkId: "WAW064",
        severity: "warning",
        message: `TransitGatewayRoute "${logicalId}" declares Blackhole: true for destination ${cidr} — traffic matching this route is silently dropped; confirm this is intentional`,
        entity: logicalId,
        lexicon: "aws",
      });
    }
  }

  return diagnostics;
}

export const waw064: PostSynthCheck = {
  id: "WAW064",
  description: "Transit Gateway route table declares a Blackhole route — confirm the traffic drop is intentional, not an accident",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkTgwBlackholeRoute(ctx);
  },
};
