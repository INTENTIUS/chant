import { RdsInstance } from "@intentius/chant-lexicon-aws";
import { Ref } from "@intentius/chant-lexicon-aws";
import { network } from "./network";
import { dbPasswordSsmPath } from "./params";

export const database = RdsInstance({
  engine: "postgres",
  vpcId: network.vpc.VpcId,
  subnetIds: [network.privateSubnet1.SubnetId, network.privateSubnet2.SubnetId],
  ingressCidr: "10.0.0.0/16",
  masterPassword: Ref(dbPasswordSsmPath) as unknown as string,
  databaseName: "myapp",
});
