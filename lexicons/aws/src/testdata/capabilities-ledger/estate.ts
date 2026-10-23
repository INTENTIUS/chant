// "ledger": the CloudFormation form of the estate chant#4361 measured the rule language on (#4375).
import {
  Bucket, DbInstance, EC2Route, EC2SecurityGroupIngress, Function, Instance, InstanceProfile,
  InternetGateway, LaunchTemplate, ManagedPolicy, Policy, Role, RouteTable, S3BucketPolicy, Secret,
  SecurityGroup, Subnet, SubnetRouteTableAssociation, Table, Url, Vpc, VPCGatewayAttachment, Ref, Sub,
} from "@intentius/chant-lexicon-aws";

const AMI = "ami-0f3f13f145e66a0a3";
const restricted = [{ Key: "data-classification", Value: "restricted" }];
const trustService = (svc: string) => ({
  Version: "2012-10-17",
  Statement: [{ Effect: "Allow", Principal: { Service: svc }, Action: "sts:AssumeRole" }],
});

// network
export const vpc = new Vpc({ CidrBlock: "10.0.0.0/16" });
export const publicSubnet = new Subnet({ VpcId: vpc.VpcId, CidrBlock: "10.0.0.0/24" });
export const privateSubnet = new Subnet({ VpcId: vpc.VpcId, CidrBlock: "10.0.1.0/24" });
export const igw = new InternetGateway({});
export const igwAttachment = new VPCGatewayAttachment({ VpcId: vpc.VpcId, InternetGatewayId: igw.InternetGatewayId });
export const publicRt = new RouteTable({ VpcId: vpc.VpcId });
export const privateRt = new RouteTable({ VpcId: vpc.VpcId });
export const publicDefault = new EC2Route({ RouteTableId: publicRt.RouteTableId, DestinationCidrBlock: "0.0.0.0/0", GatewayId: igw.InternetGatewayId });
export const publicAssoc = new SubnetRouteTableAssociation({ RouteTableId: publicRt.RouteTableId, SubnetId: publicSubnet.SubnetId });
export const privateAssoc = new SubnetRouteTableAssociation({ RouteTableId: privateRt.RouteTableId, SubnetId: privateSubnet.SubnetId });

export const webSg = new SecurityGroup({
  GroupDescription: "web", VpcId: vpc.VpcId,
  SecurityGroupIngress: [
    { IpProtocol: "tcp", FromPort: 443, ToPort: 443, CidrIp: "0.0.0.0/0" },
    { IpProtocol: "tcp", FromPort: 22, ToPort: 22, CidrIp: "0.0.0.0/0" },
  ],
});
export const appSg = new SecurityGroup({ GroupDescription: "app", VpcId: vpc.VpcId });
export const appFromWeb = new EC2SecurityGroupIngress({
  GroupId: appSg.GroupId, IpProtocol: "tcp", FromPort: 8080, ToPort: 8080, SourceSecurityGroupId: webSg.GroupId,
});
export const dbSg = new SecurityGroup({
  GroupDescription: "db", VpcId: vpc.VpcId,
  SecurityGroupIngress: [{ IpProtocol: "tcp", FromPort: 5432, ToPort: 5432, SourceSecurityGroupId: appSg.GroupId }],
});

// data
export const assets = new Bucket({ PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true } });
export const customerData = new Bucket({ Tags: restricted, PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true } });
export const ordersTable = new Table({
  KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
  AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
  BillingMode: "PAY_PER_REQUEST",
});
export const dbSecret = new Secret({ GenerateSecretString: { PasswordLength: 32 } });
export const customersDb = new DbInstance({
  Engine: "postgres", DBInstanceClass: "db.t3.micro", AllocatedStorage: "20",
  MasterUsername: "ledger", MasterUserPassword: Sub`{{resolve:secretsmanager:${Ref(dbSecret)}}}`,
  VPCSecurityGroups: [dbSg.GroupId], PubliclyAccessible: false, Tags: restricted, StorageEncrypted: true, BackupRetentionPeriod: 7,
});

// identity
export const webRole = new Role({ AssumeRolePolicyDocument: trustService("ec2.amazonaws.com") });
export const deployRole = new Role({
  AssumeRolePolicyDocument: {
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Principal: { AWS: webRole.Arn }, Action: "sts:AssumeRole" }],
  },
});
export const webPolicy = new Policy({
  PolicyName: "web", Roles: [Ref(webRole)],
  PolicyDocument: {
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: "s3:GetObject", Resource: Sub`${assets.Arn}/*` },
      { Effect: "Allow", Action: "sts:AssumeRole", Resource: deployRole.Arn },
    ],
  },
});
export const deployPolicy = new Policy({
  PolicyName: "deploy", Roles: [Ref(deployRole)],
  PolicyDocument: {
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: "s3:*", Resource: [customerData.Arn, Sub`${customerData.Arn}/*`] },
      { Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: Ref(dbSecret) },
    ],
  },
});
export const workerRole = new Role({
  AssumeRolePolicyDocument: trustService("ec2.amazonaws.com"),
  Policies: [{
    PolicyName: "worker",
    PolicyDocument: {
      Version: "2012-10-17",
      Statement: [
        { Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: Ref(dbSecret) },
        { Effect: "Allow", Action: ["dynamodb:GetItem", "dynamodb:PutItem"], Resource: ordersTable.Arn },
      ],
    },
  }],
});
export const reporterRole = new Role({ AssumeRolePolicyDocument: trustService("lambda.amazonaws.com") });
export const reportRead = new ManagedPolicy({
  Roles: [Ref(reporterRole)],
  PolicyDocument: {
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: "s3:GetObject", Resource: Sub`${customerData.Arn}/*` },
      { Effect: "Allow", Action: "logs:*", Resource: "*" },
    ],
  },
});
export const batchRole = new Role({
  AssumeRolePolicyDocument: trustService("lambda.amazonaws.com"),
  Policies: [{
    PolicyName: "batch",
    PolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "sts:AssumeRole", Resource: "arn:aws:iam::123456789012:role/audit" }] },
  }],
});
export const auditRole = new Role({
  RoleName: "audit",
  AssumeRolePolicyDocument: {
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Principal: { AWS: batchRole.Arn }, Action: "sts:AssumeRole" }],
  },
  Policies: [{
    PolicyName: "audit",
    PolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "dynamodb:Scan", Resource: ordersTable.Arn }] },
  }],
});
export const assetsPolicy = new S3BucketPolicy({
  Bucket: Ref(assets),
  PolicyDocument: {
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Principal: { AWS: workerRole.Arn }, Action: "s3:GetObject", Resource: Sub`${assets.Arn}/*` }],
  },
});

// compute
export const webProfile = new InstanceProfile({ Roles: [Ref(webRole)] });
export const workerProfile = new InstanceProfile({ Roles: [Ref(workerRole)] });
export const webTemplate = new LaunchTemplate({
  LaunchTemplateData: { InstanceType: "t3.micro", ImageId: AMI, SecurityGroupIds: [webSg.GroupId] },
});
export const webServer = new Instance({
  LaunchTemplate: { LaunchTemplateId: webTemplate.LaunchTemplateId, Version: "1" },
  SubnetId: publicSubnet.SubnetId, IamInstanceProfile: Ref(webProfile),
});
export const worker = new Instance({
  ImageId: AMI, InstanceType: "t3.micro", SubnetId: privateSubnet.SubnetId,
  SecurityGroupIds: [appSg.GroupId], IamInstanceProfile: Ref(workerProfile),
});
// in a public subnet, but nothing on the internet is allowed in
export const adminBox = new Instance({
  ImageId: AMI, InstanceType: "t3.micro", SubnetId: publicSubnet.SubnetId,
  SecurityGroupIds: [appSg.GroupId], IamInstanceProfile: Ref(workerProfile),
});
export const reporter = new Function({
  Runtime: "nodejs22.x", Handler: "index.handler", Role: reporterRole.Arn, Code: { ZipFile: "exports.handler=async()=>1" },
});
export const reporterUrl = new Url({ TargetFunctionArn: reporter.Arn, AuthType: "NONE" });
export const batch = new Function({
  Runtime: "nodejs22.x", Handler: "index.handler", Role: batchRole.Arn, Code: { ZipFile: "exports.handler=async()=>1" },
});
