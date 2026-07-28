import { VpcDefault, Parameter } from "@intentius/chant-lexicon-aws";

// A default VPC is enough to have something worth exporting — this example is
// about the Outputs section, not about the network.
export const network = VpcDefault({});

// A CloudFormation Parameter — carries no attributes at all (chant #1152), so
// a `Ref` to one is the shape `outputs.ts`'s `EnvironmentName` output exists
// to exercise: an intrinsic whose only nested entity is a Declarable, never
// an AttrRef.
export const environment = new Parameter("String", {
  description: "Deployment environment name",
  defaultValue: "staging",
});
