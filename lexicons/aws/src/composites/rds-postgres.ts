import { Composite } from "@intentius/chant";
import {
  DbInstance,
  RDSDBSubnetGroup,
  RDSDBParameterGroup,
  SecurityGroup,
  SecurityGroup_Ingress,
} from "../generated";

export interface RdsPostgresProps {
  // ── Networking (required) ─────────────────────────────────────
  vpcId: string;
  subnetIds: string[];
  ingressSourceSG?: string;
  ingressCidr?: string;
  port?: number;
  publiclyAccessible?: boolean;

  // ── Identity & auth (required) ────────────────────────────────
  masterUsername?: string;
  masterPassword: string;

  // ── Engine ────────────────────────────────────────────────────
  engineVersion?: string;
  databaseName?: string;

  // ── Instance sizing ───────────────────────────────────────────
  instanceClass?: string;
  allocatedStorage?: number;
  storageType?: string;
  maxAllocatedStorage?: number;

  // ── High availability ─────────────────────────────────────────
  multiAZ?: boolean;

  // ── Encryption ────────────────────────────────────────────────
  storageEncrypted?: boolean;
  kmsKeyId?: string;

  // ── Backup ────────────────────────────────────────────────────
  backupRetentionPeriod?: number;
  preferredBackupWindow?: string;
  copyTagsToSnapshot?: boolean;

  // ── Maintenance ───────────────────────────────────────────────
  preferredMaintenanceWindow?: string;
  autoMinorVersionUpgrade?: boolean;

  // ── Monitoring ────────────────────────────────────────────────
  enableCloudwatchLogs?: boolean;
  enablePerformanceInsights?: boolean;
  performanceInsightsRetentionPeriod?: number;

  // ── Parameter group ───────────────────────────────────────────
  parameterGroupFamily?: string;
  parameters?: Record<string, string>;

  // ── Protection ────────────────────────────────────────────────
  deletionProtection?: boolean;
}

export const RdsPostgres = Composite<RdsPostgresProps>((props) => {
  const port = props.port ?? 5432;
  const masterUsername = props.masterUsername ?? "postgres";
  const engineVersion = props.engineVersion ?? "16.4";
  const instanceClass = props.instanceClass ?? "db.t4g.micro";
  const allocatedStorage = props.allocatedStorage ?? 20;
  const storageType = props.storageType ?? "gp3";
  const multiAZ = props.multiAZ ?? false;
  const storageEncrypted = props.storageEncrypted ?? true;
  const backupRetentionPeriod = props.backupRetentionPeriod ?? 7;
  const copyTagsToSnapshot = props.copyTagsToSnapshot ?? true;
  const autoMinorVersionUpgrade = props.autoMinorVersionUpgrade ?? true;
  const publiclyAccessible = props.publiclyAccessible ?? false;
  const deletionProtection = props.deletionProtection ?? false;

  // DB Subnet Group
  const subnetGroup = new RDSDBSubnetGroup({
    DBSubnetGroupDescription: "Subnet group for PostgreSQL instance",
    SubnetIds: props.subnetIds,
  });

  // Security Group
  const ingressRules: InstanceType<typeof SecurityGroup_Ingress>[] = [];
  if (props.ingressSourceSG) {
    ingressRules.push(
      new SecurityGroup_Ingress({
        IpProtocol: "tcp",
        FromPort: port,
        ToPort: port,
        SourceSecurityGroupId: props.ingressSourceSG,
      }),
    );
  } else if (props.ingressCidr) {
    ingressRules.push(
      new SecurityGroup_Ingress({
        IpProtocol: "tcp",
        FromPort: port,
        ToPort: port,
        CidrIp: props.ingressCidr,
      }),
    );
  }

  const sg = new SecurityGroup({
    GroupDescription: "Security group for PostgreSQL instance",
    VpcId: props.vpcId,
    SecurityGroupIngress: ingressRules.length > 0 ? ingressRules : undefined,
  });

  // Optional Parameter Group
  let parameterGroup: InstanceType<typeof RDSDBParameterGroup> | undefined;
  if (props.parameterGroupFamily) {
    parameterGroup = new RDSDBParameterGroup({
      Family: props.parameterGroupFamily,
      Description: "Custom PostgreSQL parameter group",
      Parameters: props.parameters,
    });
  }

  // DB Instance
  const dbProps: Record<string, any> = {
    Engine: "postgres",
    EngineVersion: engineVersion,
    DBInstanceClass: instanceClass,
    MasterUsername: masterUsername,
    MasterUserPassword: props.masterPassword,
    AllocatedStorage: String(allocatedStorage),
    StorageType: storageType,
    DBSubnetGroupName: subnetGroup.Ref,
    VPCSecurityGroups: [sg.GroupId],
    Port: String(port),
    PubliclyAccessible: publiclyAccessible,
    MultiAZ: multiAZ,
    StorageEncrypted: storageEncrypted,
    BackupRetentionPeriod: backupRetentionPeriod,
    CopyTagsToSnapshot: copyTagsToSnapshot,
    AutoMinorVersionUpgrade: autoMinorVersionUpgrade,
    DeletionProtection: deletionProtection,
  };

  if (props.databaseName) dbProps.DBName = props.databaseName;
  if (props.kmsKeyId) dbProps.KmsKeyId = props.kmsKeyId;
  if (props.maxAllocatedStorage) dbProps.MaxAllocatedStorage = props.maxAllocatedStorage;
  if (props.preferredBackupWindow) dbProps.PreferredBackupWindow = props.preferredBackupWindow;
  if (props.preferredMaintenanceWindow) dbProps.PreferredMaintenanceWindow = props.preferredMaintenanceWindow;
  if (props.enableCloudwatchLogs) dbProps.EnableCloudwatchLogsExports = ["postgresql"];
  if (props.enablePerformanceInsights) {
    dbProps.EnablePerformanceInsights = true;
    if (props.performanceInsightsRetentionPeriod) {
      dbProps.PerformanceInsightsRetentionPeriod = props.performanceInsightsRetentionPeriod;
    }
  }
  if (parameterGroup) dbProps.DBParameterGroupName = parameterGroup.Ref;

  const db = new DbInstance(dbProps);

  const result: Record<string, any> = { subnetGroup, sg, db };
  if (parameterGroup) result.parameterGroup = parameterGroup;

  return result;
}, "RdsPostgres");
