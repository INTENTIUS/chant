/**
 * Aurora MySQL Serverless v2 for slurmdbd.
 *
 * Why Aurora over standalone MySQL:
 *   - Serverless v2 scales to 0 when cluster is idle (cost saving)
 *   - Multi-AZ failover built-in — slurmdbd is critical for job accounting
 *   - Automated backups with point-in-time recovery
 *
 * slurmdbd connects to this DB to store: job records, accounts, QOS, fairshare tree
 */

import { DbCluster, DbInstance, RDSDBSubnetGroup, SsmParameter } from "@intentius/chant-lexicon-aws";
import { Sub, Ref } from "@intentius/chant-lexicon-aws";
import { privateSubnet1, privateSubnet2 } from "./networking";
import { rdsSg } from "./security";
import { config } from "./config";

export const dbSubnetGroup = new RDSDBSubnetGroup({
  DBSubnetGroupDescription: Sub("\${AWS::StackName} slurmdbd subnet group"),
  SubnetIds: [privateSubnet1.SubnetId, privateSubnet2.SubnetId],
  Tags: [{ Key: "Name", Value: Sub("\${AWS::StackName}-slurmdbd-sg") }],
});

export const dbCluster = new DbCluster({
  DBClusterIdentifier: Sub("\${AWS::StackName}-slurmdbd"),  // explicit ID so monitoring can reference it
  Engine: "aurora-mysql",
  EngineVersion: "8.0.mysql_aurora.3.08.0",
  EngineMode: "provisioned",
  DatabaseName: "slurm_acct_db",
  MasterUsername: "slurm",
  ManageMasterUserPassword: true,    // stores password in Secrets Manager
  DBSubnetGroupName: dbSubnetGroup,
  VpcSecurityGroupIds: [rdsSg.GroupId],
  ServerlessV2ScalingConfiguration: {
    MinCapacity: 0.5,   // 0.5 ACU idle — slurmdbd is mostly quiet
    MaxCapacity: 4,     // 4 ACU peak — handles burst at job submission
  },
  BackupRetentionPeriod: 7,
  StorageEncrypted: true,
  Tags: [{ Key: "Name", Value: Sub("\${AWS::StackName}-slurmdbd") }],
});

export const dbInstance = new DbInstance({
  Engine: "aurora-mysql",
  DBInstanceClass: "db.serverless",
  DBClusterIdentifier: Ref(dbCluster),
  StorageEncrypted: true,  // inherited from cluster; explicit for lint compliance
  Tags: [{ Key: "Name", Value: Sub("\${AWS::StackName}-slurmdbd-instance") }],
});

// Store the cluster endpoint and secret ARN in SSM so head-node UserData can
// retrieve them without baking DNS names or ARNs into the AMI.
export const dbEndpointParam = new SsmParameter({
  Name: Sub("\/${AWS::StackName}/slurmdbd/endpoint"),
  Type: "String",
  Value: dbCluster.Endpoint_Address,
  Description: "Aurora MySQL endpoint for slurmdbd",
});

// ManageMasterUserPassword generates an auto-named secret; store the ARN so
// the head node can call GetSecretValue without needing rds:DescribeDBClusters.
export const dbSecretArnParam = new SsmParameter({
  Name: Sub("\/${AWS::StackName}/slurmdbd/secret-arn"),
  Type: "String",
  Value: dbCluster.MasterUserSecret_SecretArn,
  Description: "Secrets Manager ARN for Aurora slurmdbd master user",
});
