import { VpcDefault } from "@intentius/chant-lexicon-aws";

// A small, self-contained stack to demonstrate the lifecycle loop
// (deploy → drift → import → diff → reconcile/apply). A default VPC is enough —
// the lifecycle workflow is identical for any declared stack.
export const network = VpcDefault({});
