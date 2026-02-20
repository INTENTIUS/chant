import { Instance } from "@intentius/chant-lexicon-aws";

export const appServer = new Instance({
  imageId: "ami-12345678",
  instanceType: "t3.micro",
  dependsOn: ["DatabaseCluster"],
});
