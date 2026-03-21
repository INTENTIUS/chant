import { EfsWithAccessPoint, MountTarget, Sub, Ref, AWS } from "@intentius/chant-lexicon-aws";
import { network } from "./network";
import { appName } from "./params";

export const { securityGroup: efsSecurityGroup, fs, accessPoint } = EfsWithAccessPoint({
  name: Sub`${AWS.StackName}-${Ref(appName)}`,
  vpcId: network.vpc.VpcId,
  uid: "8983",
  gid: "8983",
  rootPath: "/solr-data",
});

export const mountTarget1 = new MountTarget({
  FileSystemId: fs.FileSystemId,
  SubnetId: network.privateSubnet1.SubnetId,
  SecurityGroups: [efsSecurityGroup.GroupId],
});

export const mountTarget2 = new MountTarget({
  FileSystemId: fs.FileSystemId,
  SubnetId: network.privateSubnet2.SubnetId,
  SecurityGroups: [efsSecurityGroup.GroupId],
});
