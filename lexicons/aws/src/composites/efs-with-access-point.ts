import { Composite } from "@intentius/chant";
import {
  EFSFileSystem,
  EFSFileSystem_ElasticFileSystemTag,
  EFSAccessPoint,
  EFSAccessPoint_PosixUser,
  EFSAccessPoint_RootDirectory,
  EFSAccessPoint_CreationInfo,
  EFSAccessPoint_AccessPointTag,
  SecurityGroup,
  SecurityGroup_Ingress,
} from "../generated";

export interface EfsWithAccessPointProps {
  name: string;
  vpcId: string;
  uid: string;
  gid: string;
  rootPath: string;
  permissions?: string;
  ingressCidr?: string;
  performanceMode?: "generalPurpose" | "maxIO";
  throughputMode?: "bursting" | "provisioned" | "elastic";
}

export const EfsWithAccessPoint = Composite<EfsWithAccessPointProps>((props) => {
  const ingressCidr = props.ingressCidr ?? "0.0.0.0/0";

  const efsIngress = new SecurityGroup_Ingress({
    IpProtocol: "tcp",
    FromPort: 2049,
    ToPort: 2049,
    CidrIp: ingressCidr,
  });

  const securityGroup = new SecurityGroup({
    GroupDescription: "EFS mount target SG",
    VpcId: props.vpcId,
    SecurityGroupIngress: [efsIngress],
  });

  const nameTag = new EFSFileSystem_ElasticFileSystemTag({
    Key: "Name",
    Value: props.name,
  });

  const fs = new EFSFileSystem({
    Encrypted: true,
    PerformanceMode: props.performanceMode ?? "generalPurpose",
    ThroughputMode: props.throughputMode ?? "bursting",
    FileSystemTags: [nameTag],
  });

  const posixUser = new EFSAccessPoint_PosixUser({ Uid: props.uid, Gid: props.gid });

  const creationInfo = new EFSAccessPoint_CreationInfo({
    OwnerUid: props.uid,
    OwnerGid: props.gid,
    Permissions: props.permissions ?? "755",
  });

  const rootDirectory = new EFSAccessPoint_RootDirectory({
    Path: props.rootPath,
    CreationInfo: creationInfo,
  });

  const apNameTag = new EFSAccessPoint_AccessPointTag({ Key: "Name", Value: props.name });

  const accessPoint = new EFSAccessPoint({
    FileSystemId: fs.FileSystemId,
    PosixUser: posixUser,
    RootDirectory: rootDirectory,
    AccessPointTags: [apNameTag],
  });

  return { securityGroup, fs, accessPoint };
}, "EfsWithAccessPoint");
