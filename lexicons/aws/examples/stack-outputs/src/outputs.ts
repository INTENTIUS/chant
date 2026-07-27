import { output, stackOutput, Sub, AWS } from "@intentius/chant-lexicon-aws";
import { network } from "./main";

// `output(ref, name)` — export a resource attribute under a chosen logical id.
export const vpcId = output(network.vpc.VpcId, "VpcId");

// `output(intrinsic, name)` — export a value COMPUTED from one, rather than
// the attribute itself.
export const vpcArn = output(
  Sub`arn:${AWS.Partition}:ec2:${AWS.Region}:${AWS.AccountId}:vpc/${network.vpc.VpcId}`,
  "VpcArn",
);

// `stackOutput(ref)` — the cross-stack sibling primitive. Same Outputs
// section; the logical id comes from the export name.
export const PublicSubnetId = stackOutput(network.publicSubnet1.SubnetId, {
  description: "First public subnet, for a consumer stack to import",
});

// `output(literal, name)` — export an already-resolved value (chant #1121):
// a real string/number/boolean the caller computed, not a reference to
// anything. Emitted as a plain `Value`, never coerced into a `Fn::GetAtt`.
export const apiVersion = output("v1", "ApiVersion");
