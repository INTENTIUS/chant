import {
  SecurityGroup,
  SecurityGroup_Ingress,
  EFSFileSystem,
  EFSFileSystem_ElasticFileSystemTag,
  EFSAccessPoint,
  EFSAccessPoint_PosixUser,
  EFSAccessPoint_RootDirectory,
  EFSAccessPoint_CreationInfo,
  EFSAccessPoint_AccessPointTag,
  MountTarget,
  Sub,
  Ref,
  AWS,
} from "@intentius/chant-lexicon-aws";
import { network } from "./network";
import { appName } from "./params";

const efsIngress = new SecurityGroup_Ingress({
  IpProtocol: "tcp",
  FromPort: 2049,
  ToPort: 2049,
  CidrIp: "0.0.0.0/0",
});

export const efsSecurityGroup = new SecurityGroup({
  GroupName: Sub`${AWS.StackName}-${Ref(appName)}-efs-sg`,
  GroupDescription: "EFS mount target SG",
  VpcId: network.vpc.VpcId,
  SecurityGroupIngress: [efsIngress],
});

const nameTag = new EFSFileSystem_ElasticFileSystemTag({
  Key: "Name",
  Value: Sub`${AWS.StackName}-${Ref(appName)}`,
});

export const fs = new EFSFileSystem({
  Encrypted: true,
  PerformanceMode: "generalPurpose",
  ThroughputMode: "bursting",
  FileSystemTags: [nameTag],
});

const posixUser = new EFSAccessPoint_PosixUser({
  Uid: "8983",
  Gid: "8983",
});

const creationInfo = new EFSAccessPoint_CreationInfo({
  OwnerUid: "8983",
  OwnerGid: "8983",
  Permissions: "755",
});

const rootDirectory = new EFSAccessPoint_RootDirectory({
  Path: "/solr-data",
  CreationInfo: creationInfo,
});

const apNameTag = new EFSAccessPoint_AccessPointTag({
  Key: "Name",
  Value: Sub`${AWS.StackName}-${Ref(appName)}-ap`,
});

export const accessPoint = new EFSAccessPoint({
  FileSystemId: fs.FileSystemId,
  PosixUser: posixUser,
  RootDirectory: rootDirectory,
  AccessPointTags: [apNameTag],
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
