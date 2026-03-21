import { Composite, mergeDefaults } from "@intentius/chant";
import {
  EcsService,
  EcsService_LoadBalancer,
  EcsService_NetworkConfiguration,
  EcsService_AwsVpcConfiguration,
  TaskDefinition,
  TaskDefinition_ContainerDefinition,
  TaskDefinition_MountPoint,
  TaskDefinition_PortMapping,
  TaskDefinition_LogConfiguration,
  TaskDefinition_KeyValuePair,
  TaskDefinition_EFSVolumeConfiguration,
  TaskDefinition_Volume,
  TargetGroup,
  ListenerRule,
  ListenerRule_Action,
  ListenerRule_RuleCondition,
  ListenerRule_PathPatternConfig,
  ListenerRule_HostHeaderConfig,
  SecurityGroup,
  SecurityGroup_Ingress,
  LogGroup,
  Role,
  Role_Policy,
  ScalableTarget,
  ApplicationAutoScalingScalingPolicy,
  ApplicationAutoScalingScalingPolicy_TargetTrackingScalingPolicyConfiguration,
  ApplicationAutoScalingScalingPolicy_PredefinedMetricSpecification,
} from "../generated";
import { Sub, Join, Select, Split } from "../intrinsics";
import { ecsTrustPolicy } from "./ecs-trust-policy";

export interface FargateServiceProps {
  // Wiring to shared ALB
  clusterArn: string;
  listenerArn: string;
  albSecurityGroupId: string;
  executionRoleArn: string;

  // Routing — at least one required
  priority: number;
  pathPatterns?: string[];
  hostHeaders?: string[];

  // Container
  image: string;
  containerPort?: number;
  cpu?: string;
  memory?: string;
  desiredCount?: number;

  // Autoscaling
  autoscaling?: {
    minCapacity?: number;
    maxCapacity: number;
    cpuTarget?: number;
    scaleInCooldown?: number;
    scaleOutCooldown?: number;
  };
  environment?: Record<string, string>;
  command?: string[];
  mountPoints?: TaskDefinition_MountPoint[];
  efsMounts?: Array<{
    fileSystemId: string;
    accessPointId?: string;
    containerPath: string;
    volumeName?: string;
    transitEncryption?: "ENABLED" | "DISABLED";
  }>;

  // Networking
  vpcId: string;
  privateSubnetIds: string[];
  healthCheckPath?: string;

  // IAM
  ManagedPolicyArns?: string[];
  Policies?: InstanceType<typeof Role_Policy>[];
  logRetentionDays?: number;
  defaults?: {
    taskRole?: Partial<ConstructorParameters<typeof Role>[0]>;
    taskDef?: Partial<ConstructorParameters<typeof TaskDefinition>[0]>;
    targetGroup?: Partial<ConstructorParameters<typeof TargetGroup>[0]>;
    service?: Partial<ConstructorParameters<typeof EcsService>[0]>;
  };
}

export const FargateService = Composite<FargateServiceProps>((props) => {
  if (!props.pathPatterns && !props.hostHeaders) {
    throw new Error("FargateService requires at least one of pathPatterns or hostHeaders");
  }
  if (props.priority < 1 || props.priority > 50000) {
    throw new Error("FargateService priority must be between 1 and 50000");
  }

  const containerPort = props.containerPort ?? 80;
  const cpu = props.cpu ?? "256";
  const memory = props.memory ?? "512";
  const desiredCount = props.desiredCount ?? 2;
  const healthCheckPath = props.healthCheckPath ?? "/";
  const logRetentionDays = props.logRetentionDays ?? 30;
  const { defaults: defs } = props;

  // Auto-inject EFS managed policy when efsMounts are present
  const EFS_POLICY = "arn:aws:iam::aws:policy/AmazonElasticFileSystemClientReadWriteAccess";
  const managedPolicies = props.ManagedPolicyArns ? [...props.ManagedPolicyArns] : [];
  if (props.efsMounts?.length && !managedPolicies.includes(EFS_POLICY)) {
    managedPolicies.push(EFS_POLICY);
  }

  // Task role — app permissions
  const taskRole = new Role(mergeDefaults({
    AssumeRolePolicyDocument: ecsTrustPolicy,
    ManagedPolicyArns: managedPolicies.length > 0 ? managedPolicies : undefined,
    Policies: props.Policies,
  }, defs?.taskRole));

  // Log group
  const logGroup = new LogGroup({
    RetentionInDays: logRetentionDays,
  });

  // Container definition
  const portMapping = new TaskDefinition_PortMapping({
    ContainerPort: containerPort,
    Protocol: "tcp",
  });

  const logConfiguration = new TaskDefinition_LogConfiguration({
    LogDriver: "awslogs",
    Options: {
      "awslogs-group": logGroup as any,
      "awslogs-region": Sub`\${AWS::Region}`,
      "awslogs-stream-prefix": "ecs",
    },
  });

  const environmentVars: InstanceType<typeof TaskDefinition_KeyValuePair>[] = [];
  if (props.environment) {
    for (const [name, value] of Object.entries(props.environment)) {
      environmentVars.push(
        new TaskDefinition_KeyValuePair({ Name: name, Value: value }),
      );
    }
  }

  // EFS volumes and mount points
  const efsVolumes = (props.efsMounts ?? []).map((m, i) =>
    new TaskDefinition_Volume({
      Name: m.volumeName ?? `efs-${i}`,
      EFSVolumeConfiguration: new TaskDefinition_EFSVolumeConfiguration({
        FileSystemId: m.fileSystemId,
        ...(m.accessPointId && { AuthorizationConfig: { AccessPointId: m.accessPointId } }),
        TransitEncryption: m.transitEncryption ?? "ENABLED",
      }),
    }),
  );

  const efsMountPoints = (props.efsMounts ?? []).map((m, i) =>
    new TaskDefinition_MountPoint({
      ContainerPath: m.containerPath,
      SourceVolume: m.volumeName ?? `efs-${i}`,
    }),
  );

  const allMountPoints = [...efsMountPoints, ...(props.mountPoints ?? [])];

  const container = new TaskDefinition_ContainerDefinition({
    Name: "app",
    Image: props.image,
    Essential: true,
    PortMappings: [portMapping],
    LogConfiguration: logConfiguration,
    Environment: environmentVars.length > 0 ? environmentVars : undefined,
    Command: props.command,
    MountPoints: allMountPoints.length > 0 ? allMountPoints : undefined,
  });

  // Task definition
  const taskDef = new TaskDefinition(mergeDefaults({
    NetworkMode: "awsvpc",
    RequiresCompatibilities: ["FARGATE"],
    Cpu: cpu,
    Memory: memory,
    ExecutionRoleArn: props.executionRoleArn,
    TaskRoleArn: taskRole.Arn,
    ContainerDefinitions: [container],
    ...(efsVolumes.length > 0 && { Volumes: efsVolumes }),
  }, defs?.taskDef));

  // Task security group — ingress on container port from ALB SG
  const taskIngress = new SecurityGroup_Ingress({
    IpProtocol: "tcp",
    FromPort: containerPort,
    ToPort: containerPort,
    SourceSecurityGroupId: props.albSecurityGroupId,
  });

  const taskSg = new SecurityGroup({
    GroupDescription: "Fargate task security group",
    VpcId: props.vpcId,
    SecurityGroupIngress: [taskIngress],
  });

  // Target group
  const targetGroup = new TargetGroup(mergeDefaults({
    TargetType: "ip",
    Protocol: "HTTP",
    Port: containerPort,
    VpcId: props.vpcId,
    HealthCheckPath: healthCheckPath,
  }, defs?.targetGroup));

  // Listener rule conditions
  const conditions: InstanceType<typeof ListenerRule_RuleCondition>[] = [];

  if (props.pathPatterns) {
    const pathConfig = new ListenerRule_PathPatternConfig({
      Values: props.pathPatterns,
    });
    conditions.push(
      new ListenerRule_RuleCondition({
        Field: "path-pattern",
        PathPatternConfig: pathConfig,
      }),
    );
  }

  if (props.hostHeaders) {
    const hostConfig = new ListenerRule_HostHeaderConfig({
      Values: props.hostHeaders,
    });
    conditions.push(
      new ListenerRule_RuleCondition({
        Field: "host-header",
        HostHeaderConfig: hostConfig,
      }),
    );
  }

  // Listener rule
  const ruleAction = new ListenerRule_Action({
    Type: "forward",
    TargetGroupArn: targetGroup.TargetGroupArn,
  });

  const rule = new ListenerRule({
    ListenerArn: props.listenerArn,
    Priority: props.priority,
    Actions: [ruleAction],
    Conditions: conditions,
  });

  // ECS Service
  const serviceLoadBalancer = new EcsService_LoadBalancer({
    ContainerName: "app",
    ContainerPort: containerPort,
    TargetGroupArn: targetGroup.TargetGroupArn,
  });

  const awsVpcConfig = new EcsService_AwsVpcConfiguration({
    Subnets: props.privateSubnetIds,
    SecurityGroups: [taskSg.GroupId],
    AssignPublicIp: "DISABLED",
  });

  const networkConfig = new EcsService_NetworkConfiguration({
    AwsvpcConfiguration: awsVpcConfig,
  });

  const service = new EcsService(
    mergeDefaults({
      Cluster: props.clusterArn,
      TaskDefinition: taskDef.TaskDefinitionArn,
      LaunchType: "FARGATE",
      DesiredCount: desiredCount,
      HealthCheckGracePeriodSeconds: 60,
      LoadBalancers: [serviceLoadBalancer],
      NetworkConfiguration: networkConfig,
    }, defs?.service),
    { DependsOn: [rule] },
  );

  let scalableTarget: InstanceType<typeof ScalableTarget> | undefined;
  let scalingPolicy: InstanceType<typeof ApplicationAutoScalingScalingPolicy> | undefined;

  if (props.autoscaling) {
    const { minCapacity = 1, maxCapacity, cpuTarget = 60, scaleInCooldown, scaleOutCooldown } = props.autoscaling;

    const resourceId = Join("/", ["service", Select(1, Split("/", props.clusterArn)), service.Name]);

    scalableTarget = new ScalableTarget({
      ServiceNamespace: "ecs",
      ScalableDimension: "ecs:service:DesiredCount",
      ResourceId: resourceId,
      MinCapacity: minCapacity,
      MaxCapacity: maxCapacity,
    });

    const trackingConfig = new ApplicationAutoScalingScalingPolicy_TargetTrackingScalingPolicyConfiguration({
      TargetValue: cpuTarget,
      PredefinedMetricSpecification: new ApplicationAutoScalingScalingPolicy_PredefinedMetricSpecification({
        PredefinedMetricType: "ECSServiceAverageCPUUtilization",
      }),
      ...(scaleInCooldown !== undefined && { ScaleInCooldown: scaleInCooldown }),
      ...(scaleOutCooldown !== undefined && { ScaleOutCooldown: scaleOutCooldown }),
    });

    scalingPolicy = new ApplicationAutoScalingScalingPolicy({
      PolicyName: Sub`\${AWS::StackName}-cpu`,
      PolicyType: "TargetTrackingScaling",
      ServiceNamespace: "ecs",
      ScalableDimension: "ecs:service:DesiredCount",
      ResourceId: resourceId,
      TargetTrackingScalingPolicyConfiguration: trackingConfig,
    });
  }

  return {
    taskRole,
    logGroup,
    taskDef,
    taskSg,
    targetGroup,
    rule,
    service,
    ...(scalableTarget ? { scalableTarget } : {}),
    ...(scalingPolicy ? { scalingPolicy } : {}),
  };
}, "FargateService");
