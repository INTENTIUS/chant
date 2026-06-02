import { output } from "@intentius/chant-lexicon-aws";
import { network } from "./main";

export const vpcId = output(network.vpc.VpcId, "VpcId");
