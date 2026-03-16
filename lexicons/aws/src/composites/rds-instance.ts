import { Composite, mergeDefaults } from "@intentius/chant";
import {
  DbInstance,
  RDSDBSubnetGroup,
  RDSDBParameterGroup,
  SecurityGroup,
  SecurityGroup_Ingress,
} from "../generated";

const ENGINE_DEFAULTS: Record<string, { port: number; username: string; version: string; logExport: string }> = {
  postgres: { port: 5432, username: "postgres", version: "16.6",  logExport: "postgresql" },
  mysql:    { port: 3306, username: "admin",    version: "8.0.40", logExport: "general" },
  mariadb:  { port: 3306, username: "admin",    version: "11.4.3", logExport: "general" },
};

export interface RdsInstanceProps {
  // ── Engine ──────────────────────────────────────────────────────
  engine?: "postgres" | "mysql" | "mariadb";

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

  // ── Engine version ──────────────────────────────────────────────
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
  defaults?: {
    subnetGroup?: Partial<ConstructorParameters<typeof RDSDBSubnetGroup>[0]>;
    sg?: Partial<ConstructorParameters<typeof SecurityGroup>[0]>;
    db?: Partial<ConstructorParameters<typeof DbInstance>[0]>;
    parameterGroup?: Partial<ConstructorParameters<typeof RDSDBParameterGroup>[0]>;
  };
}

export const RdsInstance = Composite<RdsInstanceProps>((props) => {
  const engine = props.engine ?? "postgres";
  const defaults = ENGINE_DEFAULTS[engine];
  const port = props.port ?? defaults.port;
  const masterUsername = props.masterUsername ?? defaults.username;
  const engineVersion = props.engineVersion ?? defaults.version;
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
  const { defaults: defs } = props;

  // DB Subnet Group
  const subnetGroup = new RDSDBSubnetGroup(mergeDefaults({
    DBSubnetGroupDescription: "Subnet group for RDS instance",
    SubnetIds: props.subnetIds,
  }, defs?.subnetGroup));

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

  const sg = new SecurityGroup(mergeDefaults({
    GroupDescription: "Security group for RDS instance",
    VpcId: props.vpcId,
    SecurityGroupIngress: ingressRules.length > 0 ? ingressRules : undefined,
  }, defs?.sg));

  // Optional Parameter Group
  let parameterGroup: InstanceType<typeof RDSDBParameterGroup> | undefined;
  if (props.parameterGroupFamily) {
    parameterGroup = new RDSDBParameterGroup(mergeDefaults({
      Family: props.parameterGroupFamily,
      Description: "Custom parameter group",
      Parameters: props.parameters,
    }, defs?.parameterGroup));
  }

  // DB Instance
  const dbProps: Record<string, any> = {
    Engine: engine,
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
  if (props.enableCloudwatchLogs) dbProps.EnableCloudwatchLogsExports = [defaults.logExport];
  if (props.enablePerformanceInsights) {
    dbProps.EnablePerformanceInsights = true;
    if (props.performanceInsightsRetentionPeriod) {
      dbProps.PerformanceInsightsRetentionPeriod = props.performanceInsightsRetentionPeriod;
    }
  }
  if (parameterGroup) dbProps.DBParameterGroupName = parameterGroup.Ref;

  const db = new DbInstance(mergeDefaults(dbProps, defs?.db));

  const result: Record<string, any> = { subnetGroup, sg, db };
  if (parameterGroup) result.parameterGroup = parameterGroup;

  return result;
}, "RdsInstance");
