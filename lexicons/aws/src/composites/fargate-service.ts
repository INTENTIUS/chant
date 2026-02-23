import { Composite } from "@intentius/chant";
import {
  EcsService,
  EcsService_LoadBalancer,
  EcsService_NetworkConfiguration,
  EcsService_AwsVpcConfiguration,
  TaskDefinition,
  TaskDefinition_ContainerDefinition,
  TaskDefinition_PortMapping,
  TaskDefinition_LogConfiguration,
  TaskDefinition_KeyValuePair,
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
} from "../generated";
import { Sub } from "../intrinsics";
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
  environment?: Record<string, string>;
  command?: string[];

  // Networking
  vpcId: string;
  privateSubnetIds: string[];
  healthCheckPath?: string;

  // IAM
  ManagedPolicyArns?: string[];
  Policies?: InstanceType<typeof Role_Policy>[];
  logRetentionDays?: number;
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

  // Task role — app permissions
  const taskRole = new Role({
    AssumeRolePolicyDocument: ecsTrustPolicy,
    ManagedPolicyArns: props.ManagedPolicyArns,
    Policies: props.Policies,
  });

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

  const container = new TaskDefinition_ContainerDefinition({
    Name: "app",
    Image: props.image,
    Essential: true,
    PortMappings: [portMapping],
    LogConfiguration: logConfiguration,
    Environment: environmentVars.length > 0 ? environmentVars : undefined,
    Command: props.command,
  });

  // Task definition
  const taskDef = new TaskDefinition({
    NetworkMode: "awsvpc",
    RequiresCompatibilities: ["FARGATE"],
    Cpu: cpu,
    Memory: memory,
    ExecutionRoleArn: props.executionRoleArn,
    TaskRoleArn: taskRole.Arn,
    ContainerDefinitions: [container],
  });

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
  const targetGroup = new TargetGroup({
    TargetType: "ip",
    Protocol: "HTTP",
    Port: containerPort,
    VpcId: props.vpcId,
    HealthCheckPath: healthCheckPath,
  });

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
    {
      Cluster: props.clusterArn,
      TaskDefinition: taskDef.TaskDefinitionArn,
      LaunchType: "FARGATE",
      DesiredCount: desiredCount,
      HealthCheckGracePeriodSeconds: 60,
      LoadBalancers: [serviceLoadBalancer],
      NetworkConfiguration: networkConfig,
    },
    { DependsOn: [rule] },
  );

  return {
    taskRole,
    logGroup,
    taskDef,
    taskSg,
    targetGroup,
    rule,
    service,
  };
}, "FargateService");
