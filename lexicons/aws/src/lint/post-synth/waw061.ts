/**
 * WAW061: Subnet CIDR Not Contained In VPC CIDR
 *
 * A subnet's CidrBlock must fall entirely inside its VPC's CidrBlock.
 * Stock CDK does not check this — CloudFormation accepts the template and
 * only fails the `AWS::EC2::Subnet` resource at deploy time
 * ("The CIDR ... is invalid" / "does not fall within the CIDR range of the
 * VPC"), after the rest of the stack may have already started rolling out.
 * This is a cheap static graph check: follow the subnet's VpcId Ref to a
 * declared VPC in the same template and do IPv4 CIDR-range math.
 *
 * Stays quiet whenever the graph can't prove it: intrinsic CIDR blocks,
 * IPv6, a VpcId that isn't a simple Ref to a declared AWS::EC2::VPC, or a
 * VPC whose own CidrBlock isn't a literal string.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate, findResourceRefs, ipv4CidrContains } from "./cf-refs";

export function checkSubnetCidrContainment(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      if (resource.Type !== "AWS::EC2::Subnet") continue;

      const props = resource.Properties ?? {};
      const subnetCidr = props.CidrBlock;
      if (typeof subnetCidr !== "string") continue;

      const vpcRefs = findResourceRefs(props.VpcId);
      if (vpcRefs.size !== 1) continue;
      const [vpcId] = vpcRefs;

      const vpc = template.Resources[vpcId];
      if (!vpc || vpc.Type !== "AWS::EC2::VPC") continue;

      const vpcCidr = vpc.Properties?.CidrBlock;
      if (typeof vpcCidr !== "string") continue;

      const contained = ipv4CidrContains(vpcCidr, subnetCidr);
      if (contained === false) {
        diagnostics.push({
          checkId: "WAW061",
          severity: "error",
          message: `Subnet "${logicalId}" CidrBlock ${subnetCidr} is not contained within VPC "${vpcId}"'s CidrBlock ${vpcCidr} — CloudFormation rejects this at deploy time`,
          entity: logicalId,
          lexicon: "aws",
        });
      }
    }
  }

  return diagnostics;
}

export const waw061: PostSynthCheck = {
  id: "WAW061",
  description: "Subnet CidrBlock falls outside its VPC's CidrBlock — fails at deploy time",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkSubnetCidrContainment(ctx);
  },
};
