import { Composite, mergeDefaults } from "@intentius/chant";
import {
  EcsCluster,
  LoadBalancer,
  Listener,
  Listener_Action,
  Listener_FixedResponseConfig,
  Listener_Certificate,
  SecurityGroup,
  SecurityGroup_Ingress,
  Role,
  Role_Policy,
} from "../generated";
import { ECRActions } from "../actions/ecr";
import { LogsActions } from "../actions/logs";
import { ecsTrustPolicy } from "./ecs-trust-policy";

export interface AlbSharedProps {
  vpcId: string;
  publicSubnetIds: string[];
  listenerPort?: number;
  protocol?: "HTTP" | "HTTPS";
  certificateArn?: string;
  defaults?: {
    cluster?: Partial<ConstructorParameters<typeof EcsCluster>[0]>;
    executionRole?: Partial<ConstructorParameters<typeof Role>[0]>;
    alb?: Partial<ConstructorParameters<typeof LoadBalancer>[0]>;
    listener?: Partial<ConstructorParameters<typeof Listener>[0]>;
  };
}

export const AlbShared = Composite<AlbSharedProps>((props) => {
  const listenerPort = props.listenerPort ?? 80;
  const protocol = props.protocol ?? "HTTP";
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

  // ALB security group — ingress on listener port from anywhere
  const albIngress = new SecurityGroup_Ingress({
    IpProtocol: "tcp",
    FromPort: listenerPort,
    ToPort: listenerPort,
    CidrIp: "0.0.0.0/0",
  });

  const albSg = new SecurityGroup({
    GroupDescription: "ALB security group",
    VpcId: props.vpcId,
    SecurityGroupIngress: [albIngress],
  });

  // Application Load Balancer
  const alb = new LoadBalancer(mergeDefaults({
    Type: "application",
    Scheme: "internet-facing",
    Subnets: props.publicSubnetIds,
    SecurityGroups: [albSg.GroupId],
  }, defs?.alb));

  // Listener — default action is fixed-response 404
  const fixedResponse = new Listener_FixedResponseConfig({
    StatusCode: "404",
    ContentType: "text/plain",
    MessageBody: "Not Found",
  });

  const defaultAction = new Listener_Action({
    Type: "fixed-response",
    FixedResponseConfig: fixedResponse,
  });

  const listenerProps: Record<string, unknown> = {
    LoadBalancerArn: alb.LoadBalancerArn,
    Port: listenerPort,
    Protocol: protocol,
    DefaultActions: [defaultAction],
  };

  if (protocol === "HTTPS" && props.certificateArn) {
    const cert = new Listener_Certificate({
      CertificateArn: props.certificateArn,
    });
    listenerProps.Certificates = [cert];
  }

  const listener = new Listener(mergeDefaults(listenerProps, defs?.listener));

  return {
    cluster,
    executionRole,
    albSg,
    alb,
    listener,
  };
}, "AlbShared");
