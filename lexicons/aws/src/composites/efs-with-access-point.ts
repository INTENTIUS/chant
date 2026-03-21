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
  /** CIDR allowed inbound on NFS port 2049. Mutually exclusive with sourceSecurityGroupId.
   *  When neither ingressCidr nor sourceSecurityGroupId is set, no inline ingress rule is created
   *  (add a cross-stack EC2SecurityGroupIngress separately). */
  ingressCidr?: string;
  /** Security group ID allowed inbound on NFS port 2049. When provided, overrides ingressCidr. */
  sourceSecurityGroupId?: string;
  performanceMode?: "generalPurpose" | "maxIO";
  throughputMode?: "bursting" | "provisioned" | "elastic";
}

export const EfsWithAccessPoint = Composite<EfsWithAccessPointProps>((props) => {
  const ingressRules: SecurityGroup_Ingress[] = [];
  if (props.sourceSecurityGroupId) {
    ingressRules.push(new SecurityGroup_Ingress({
      IpProtocol: "tcp",
      FromPort: 2049,
      ToPort: 2049,
      SourceSecurityGroupId: props.sourceSecurityGroupId,
    }));
  } else if (props.ingressCidr) {
    ingressRules.push(new SecurityGroup_Ingress({
      IpProtocol: "tcp",
      FromPort: 2049,
      ToPort: 2049,
      CidrIp: props.ingressCidr,
    }));
  }

  const securityGroup = new SecurityGroup({
    GroupDescription: "EFS mount target SG",
    VpcId: props.vpcId,
    ...(ingressRules.length > 0 ? { SecurityGroupIngress: ingressRules } : {}),
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
