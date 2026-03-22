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
  DBSubnetGroupDescription: `${config.clusterName} slurmdbd subnet group`,
  SubnetIds: [privateSubnet1.SubnetId, privateSubnet2.SubnetId],
  Tags: [{ Key: "Name", Value: `${config.clusterName}-slurmdbd-sg` }],
});

export const dbCluster = new DbCluster({
  DBClusterIdentifier: config.dbClusterIdentifier,  // explicit ID so monitoring can reference it
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
  Tags: [{ Key: "Name", Value: `${config.clusterName}-slurmdbd` }],
});

export const dbInstance = new DbInstance({
  Engine: "aurora-mysql",
  DBInstanceClass: "db.serverless",
  DBClusterIdentifier: Ref(dbCluster),
  StorageEncrypted: true,  // inherited from cluster; explicit for lint compliance
  Tags: [{ Key: "Name", Value: `${config.clusterName}-slurmdbd-instance` }],
});

// Store the cluster endpoint in SSM so head-node UserData can retrieve it
// without baking the DNS name into the AMI.
export const dbEndpointParam = new SsmParameter({
  Name: Sub(`/${config.clusterName}/slurmdbd/endpoint`),
  Type: "String",
  Value: dbCluster.Endpoint_Address,
  Description: "Aurora MySQL endpoint for slurmdbd",
});
