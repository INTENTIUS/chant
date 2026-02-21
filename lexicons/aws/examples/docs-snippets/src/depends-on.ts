import { Instance } from "@intentius/chant-lexicon-aws";

export const appServer = new Instance({
  ImageId: "ami-12345678",
  InstanceType: "t3.micro",
  dependsOn: ["DatabaseCluster"],
});
