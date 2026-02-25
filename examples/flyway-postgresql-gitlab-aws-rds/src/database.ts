import { RdsInstance } from "@intentius/chant-lexicon-aws";
import { Sub } from "@intentius/chant-lexicon-aws";
import { network } from "./network";
import { dbPasswordSsmPath } from "./params";

export const database = RdsInstance({
  engine: "postgres",
  vpcId: network.vpc.VpcId,
  subnetIds: [network.publicSubnet1.SubnetId, network.publicSubnet2.SubnetId],
  ingressCidr: "0.0.0.0/0",
  publiclyAccessible: true,
  masterPassword: Sub("{{resolve:ssm-secure:${dbPasswordSsmPath}}}") as unknown as string,
  databaseName: "myapp",
});
