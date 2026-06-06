import { Composite, mergeDefaults } from "@intentius/chant";
import {
  EcsCluster,
  EcsService,
  EcsService_LoadBalancer,
  EcsService_NetworkConfiguration,
  EcsService_AwsVpcConfiguration,
  TaskDefinition,
  TaskDefinition_ContainerDefinition,
  TaskDefinition_PortMapping,
  TaskDefinition_LogConfiguration,
  TaskDefinition_KeyValuePair,
  LoadBalancer,
  TargetGroup,
  Listener,
  Listener_Action,
  Listener_Certificate,
  Listener_RedirectConfig,
  SecurityGroup,
  SecurityGroup_Ingress,
  LogGroup,
  Role,
  Role_Policy,
} from "../generated";
import { Sub } from "../intrinsics";
import { ECRActions } from "../actions/ecr";
import { LogsActions } from "../actions/logs";
import { ecsTrustPolicy } from "./ecs-trust-policy";

export interface FargateAlbProps {
  image: string;
  /**
   * Secrets Manager ARN holding private-registry pull credentials
   * (`{"username","password"}`). Sets the container's `RepositoryCredentials`
   * and grants the execution role `secretsmanager:GetSecretValue` on it — needed
   * to pull from a private registry such as GHCR. Omit for public images / ECR.
   */
  repositoryCredentials?: string;
  /**
   * ACM certificate ARN. When set, the ALB serves HTTPS on 443 with this cert
   * and the port-80 listener redirects to HTTPS (301). When omitted, the ALB
   * serves plain HTTP on `listenerPort` (default 80). The cert + any DNS records
   * are managed outside this composite (region must match the ALB).
   */
  certificateArn?: string;
  containerPort?: number;
  cpu?: string;
  memory?: string;
  desiredCount?: number;
  vpcId: string;
  publicSubnetIds: string[];
  privateSubnetIds: string[];
  healthCheckPath?: string;
  listenerPort?: number;
  environment?: Record<string, string>;
  command?: string[];
  ManagedPolicyArns?: string[];
  Policies?: InstanceType<typeof Role_Policy>[];
  logRetentionDays?: number;
  defaults?: {
    cluster?: Partial<ConstructorParameters<typeof EcsCluster>[0]>;
    executionRole?: Partial<ConstructorParameters<typeof Role>[0]>;
    taskRole?: Partial<ConstructorParameters<typeof Role>[0]>;
    taskDef?: Partial<ConstructorParameters<typeof TaskDefinition>[0]>;
    alb?: Partial<ConstructorParameters<typeof LoadBalancer>[0]>;
    targetGroup?: Partial<ConstructorParameters<typeof TargetGroup>[0]>;
    service?: Partial<ConstructorParameters<typeof EcsService>[0]>;
  };
}

export const FargateAlb = Composite<FargateAlbProps>((props) => {
  const containerPort = props.containerPort ?? 80;
  const cpu = props.cpu ?? "256";
  const memory = props.memory ?? "512";
  const desiredCount = props.desiredCount ?? 2;
  const healthCheckPath = props.healthCheckPath ?? "/";
  const listenerPort = props.listenerPort ?? 80;
  const logRetentionDays = props.logRetentionDays ?? 30;
  const { defaults: defs } = props;

  // ECS Cluster
  const cluster = new EcsCluster(mergeDefaults({}, defs?.cluster));

  // Execution role — ECR pull + CloudWatch Logs write
  const executionPolicyDocument = {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: ECRActions.Pull,
        Resource: "*",
      },
      {
        Effect: "Allow",
        Action: LogsActions.Write,
        Resource: "*",
      },
      // Allow pulling private-registry credentials when configured.
      ...(props.repositoryCredentials
        ? [{
            Effect: "Allow",
            Action: ["secretsmanager:GetSecretValue"],
            Resource: props.repositoryCredentials,
          }]
        : []),
    ],
  };

  const executionPolicy = new Role_Policy({
    PolicyName: "ExecutionPolicy",
    PolicyDocument: executionPolicyDocument,
  });

  const executionRole = new Role(mergeDefaults({
    AssumeRolePolicyDocument: ecsTrustPolicy,
    Policies: [executionPolicy],
  }, defs?.executionRole));

  // Task role — app permissions
  const taskRole = new Role(mergeDefaults({
    AssumeRolePolicyDocument: ecsTrustPolicy,
    ManagedPolicyArns: props.ManagedPolicyArns,
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

  const container = new TaskDefinition_ContainerDefinition({
    Name: "app",
    Image: props.image,
    Essential: true,
    PortMappings: [portMapping],
    LogConfiguration: logConfiguration,
    Environment: environmentVars.length > 0 ? environmentVars : undefined,
    Command: props.command,
    RepositoryCredentials: props.repositoryCredentials
      ? { CredentialsParameter: props.repositoryCredentials }
      : undefined,
  });

  // Task definition
  const taskDef = new TaskDefinition(mergeDefaults({
    NetworkMode: "awsvpc",
    RequiresCompatibilities: ["FARGATE"],
    Cpu: cpu,
    Memory: memory,
    ExecutionRoleArn: executionRole.Arn,
    TaskRoleArn: taskRole.Arn,
    ContainerDefinitions: [container],
  }, defs?.taskDef));

  // ALB security group — ingress on the served port(s) from anywhere. With a
  // cert that's 443 (HTTPS) + 80 (redirect); otherwise the plain listener port.
  const ingressPorts = props.certificateArn ? [443, 80] : [listenerPort];
  const albIngress = ingressPorts.map((port) =>
    new SecurityGroup_Ingress({
      IpProtocol: "tcp",
      FromPort: port,
      ToPort: port,
      CidrIp: "0.0.0.0/0",
    }),
  );

  const albSg = new SecurityGroup({
    GroupDescription: "ALB security group",
    VpcId: props.vpcId,
    SecurityGroupIngress: albIngress,
  });

  // Task security group — ingress on container port from ALB SG
  const taskIngress = new SecurityGroup_Ingress({
    IpProtocol: "tcp",
    FromPort: containerPort,
    ToPort: containerPort,
    SourceSecurityGroupId: albSg.GroupId,
  });

  const taskSg = new SecurityGroup({
    GroupDescription: "Fargate task security group",
    VpcId: props.vpcId,
    SecurityGroupIngress: [taskIngress],
  });

  // Application Load Balancer
  const alb = new LoadBalancer(mergeDefaults({
    Type: "application",
    Scheme: "internet-facing",
    Subnets: props.publicSubnetIds,
    SecurityGroups: [albSg.GroupId],
  }, defs?.alb));

  // Target group
  const targetGroup = new TargetGroup(mergeDefaults({
    TargetType: "ip",
    Protocol: "HTTP",
    Port: containerPort,
    VpcId: props.vpcId,
    HealthCheckPath: healthCheckPath,
  }, defs?.targetGroup));

  // Listener(s). With a cert: HTTPS:443 forwards to the target group and HTTP:80
  // redirects to HTTPS. Without: a single HTTP listener on `listenerPort`.
  const forwardAction = new Listener_Action({
    Type: "forward",
    TargetGroupArn: targetGroup.TargetGroupArn,
  });

  let listener: InstanceType<typeof Listener>;
  let redirectListener: InstanceType<typeof Listener> | undefined;

  if (props.certificateArn) {
    listener = new Listener({
      LoadBalancerArn: alb.LoadBalancerArn,
      Port: 443,
      Protocol: "HTTPS",
      Certificates: [new Listener_Certificate({ CertificateArn: props.certificateArn })],
      DefaultActions: [forwardAction],
    });
    redirectListener = new Listener({
      LoadBalancerArn: alb.LoadBalancerArn,
      Port: 80,
      Protocol: "HTTP",
      DefaultActions: [
        new Listener_Action({
          Type: "redirect",
          RedirectConfig: new Listener_RedirectConfig({
            Protocol: "HTTPS",
            Port: "443",
            StatusCode: "HTTP_301",
          }),
        }),
      ],
    });
  } else {
    listener = new Listener({
      LoadBalancerArn: alb.LoadBalancerArn,
      Port: listenerPort,
      Protocol: "HTTP",
      DefaultActions: [forwardAction],
    });
  }

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
      Cluster: cluster.Arn,
      TaskDefinition: taskDef.TaskDefinitionArn,
      LaunchType: "FARGATE",
      DesiredCount: desiredCount,
      HealthCheckGracePeriodSeconds: 60,
      LoadBalancers: [serviceLoadBalancer],
      NetworkConfiguration: networkConfig,
    }, defs?.service),
    { DependsOn: [listener] },
  );

  return {
    cluster,
    executionRole,
    taskRole,
    logGroup,
    taskDef,
    albSg,
    taskSg,
    alb,
    targetGroup,
    listener,
    ...(redirectListener ? { redirectListener } : {}),
    service,
  };
}, "FargateAlb");
