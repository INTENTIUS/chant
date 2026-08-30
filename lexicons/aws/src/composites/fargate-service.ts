import { Composite, mergeDefaults, type Value } from "@intentius/chant";
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
  TaskDefinition_Ulimit,
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

/**
 * The ALB `ListenerRule`'s real `Priority` bounds (documented on
 * `elasticloadbalancing:CreateRule`, and enforced the same way for a
 * CloudFormation-managed rule) — not an opinion this composite holds.
 *
 * Exported for the same reason as `MICROVM_LIMITS` (#1374, #1420): a
 * consumer routing to the same shared ALB through another control plane
 * needs the same numbers, and copying them is how two sources of truth
 * start.
 */
export const FARGATE_SERVICE_LIMITS = {
  priority: { min: 1, max: 50000 },
} as const;

export interface FargateServiceProps {
  // Wiring to shared ALB.
  //
  // `Value<string>` rather than `string`: these are exactly the props a
  // consuming stack fills from a cross-stack reference, and the documented way
  // to do that is `Ref(param)` — an Intrinsic, not a literal. Typing them
  // `string` made the composite's own examples a type error (#1366).
  clusterArn: Value<string>;
  listenerArn: Value<string>;
  albSecurityGroupId: Value<string>;
  executionRoleArn: Value<string>;

  // Routing — at least one required. Bounds: {@link FARGATE_SERVICE_LIMITS.priority}.
  priority: number;
  pathPatterns?: string[];
  hostHeaders?: string[];

  // Container
  image: Value<string>;
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
  mountPoints?: InstanceType<typeof TaskDefinition_MountPoint>[];
  efsMounts?: Array<{
    fileSystemId: string;
    accessPointId?: string;
    containerPath: string;
    volumeName?: string;
    transitEncryption?: "ENABLED" | "DISABLED";
  }>;

  // Networking
  vpcId: Value<string>;
  privateSubnetIds: Array<Value<string>>;
  healthCheckPath?: string;

  // Ulimits (container-level)
  ulimits?: Array<{ name: string; softLimit: number; hardLimit: number }>;

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

export const FargateService = Composite((props: FargateServiceProps) => {
  if (!props.pathPatterns && !props.hostHeaders) {
    throw new Error("FargateService requires at least one of pathPatterns or hostHeaders");
  }
  if (props.priority < FARGATE_SERVICE_LIMITS.priority.min || props.priority > FARGATE_SERVICE_LIMITS.priority.max) {
    throw new Error(
      `FargateService priority must be between ${FARGATE_SERVICE_LIMITS.priority.min} and ${FARGATE_SERVICE_LIMITS.priority.max}`,
    );
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

  // `.map` keeps the `new`s out of the `for`/`if` (EVL002).
  const environmentVars: InstanceType<typeof TaskDefinition_KeyValuePair>[] = props.environment
    ? Object.entries(props.environment).map(([name, value]) => new TaskDefinition_KeyValuePair({ Name: name, Value: value }))
    : [];

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
    Ulimits: props.ulimits?.map(u => new TaskDefinition_Ulimit({
      Name: u.name,
      SoftLimit: u.softLimit,
      HardLimit: u.hardLimit,
    })),
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
  // Conditional entries via spread keep the `new`s out of the `if`s (EVL002).
  const conditions: InstanceType<typeof ListenerRule_RuleCondition>[] = [
    ...(props.pathPatterns
      ? [new ListenerRule_RuleCondition({
          Field: "path-pattern",
          PathPatternConfig: new ListenerRule_PathPatternConfig({ Values: props.pathPatterns }),
        })]
      : []),
    ...(props.hostHeaders
      ? [new ListenerRule_RuleCondition({
          Field: "host-header",
          HostHeaderConfig: new ListenerRule_HostHeaderConfig({ Values: props.hostHeaders }),
        })]
      : []),
  ];

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

  // Closure (invoked below) keeps the autoscaling `new`s out of the `if` (EVL002);
  // the guard narrows `props.autoscaling` for the body.
  const buildAutoscaling = () => {
    if (!props.autoscaling) return;
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
  };

  if (props.autoscaling) buildAutoscaling();

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
