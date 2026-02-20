import * as _ from "./_";

export const appServer = new _.Instance({
  imageId: "ami-12345678",
  instanceType: "t3.micro",
  dependsOn: ["DatabaseCluster"],
});
