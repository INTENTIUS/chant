import { output, stackOutput, Sub, Ref, AWS } from "@intentius/chant-lexicon-aws";
import { network, environment } from "./main";

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

// `stackOutput(Ref(parameter))` — a Parameter carries no attributes at all,
// so the intrinsic's only nested entity is the Parameter Declarable itself,
// never an AttrRef (chant #1152). The anchor search has to recognize the
// wrapped entity directly rather than only ever looking for a nested AttrRef.
export const EnvironmentName = stackOutput(Ref(environment), {
  description: "Deployment environment, for a consumer stack to import",
  exportName: "EnvironmentName",
});
