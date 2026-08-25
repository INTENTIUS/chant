import { Composite, mergeDefaults } from "@intentius/chant";
import {
  LoadBalancer,
  TargetGroup,
  TargetGroup_TargetDescription,
  Listener,
  Listener_Action,
  Listener_Certificate,
} from "../generated";

export interface NlbServiceProps {
  vpcId: string;
  subnetIds: string[];
  listenerPort?: number;
  /** Port the target group forwards traffic to. Defaults to `listenerPort`. */
  targetPort?: number;
  /**
   * Listener + target group protocol. `TLS` terminates TLS at the NLB and
   * requires `certificateArn`; the other protocols pass traffic through
   * unmodified, which is the common case for a Network Load Balancer.
   */
  protocol?: "TCP" | "UDP" | "TLS" | "TCP_UDP";
  scheme?: "internet-facing" | "internal";
  /**
   * Target group target type. `ip` (the default) covers Fargate awsvpc tasks
   * and any routable IP; use `instance` to register EC2 instance IDs directly,
   * or `alb` to chain an NLB in front of an existing Application Load Balancer.
   */
  targetType?: "instance" | "ip" | "alb";
  /**
   * Static targets to register at creation time (instance IDs, IPs, or an ALB
   * ARN depending on `targetType`). Omit when targets self-register instead —
   * an ECS service, for instance, that references `targetGroup.TargetGroupArn`.
   */
  targets?: Array<{ id: string; port?: number; availabilityZone?: string }>;
  /** ACM certificate ARN. Required when `protocol` is `TLS`. */
  certificateArn?: string;
  healthCheckProtocol?: "TCP" | "HTTP" | "HTTPS";
  healthCheckPort?: string;
  /** Only meaningful when `healthCheckProtocol` is `HTTP` or `HTTPS`. */
  healthCheckPath?: string;
  defaults?: {
    nlb?: Partial<ConstructorParameters<typeof LoadBalancer>[0]>;
    targetGroup?: Partial<ConstructorParameters<typeof TargetGroup>[0]>;
    listener?: Partial<ConstructorParameters<typeof Listener>[0]>;
  };
}

export const NlbService = Composite((props: NlbServiceProps) => {
  if (props.protocol === "TLS" && !props.certificateArn) {
    throw new Error("NlbService requires certificateArn when protocol is TLS");
  }

  const listenerPort = props.listenerPort ?? 80;
  const targetPort = props.targetPort ?? listenerPort;
  const protocol = props.protocol ?? "TCP";
  const scheme = props.scheme ?? "internet-facing";
  const targetType = props.targetType ?? "ip";
  const { defaults: defs } = props;

  // Network Load Balancer. Unlike the ALB composites, no security group is
  // created here — NLBs pass through the client's source IP by default, so
  // access control belongs on the target side (or via an explicit SG passed
  // through `defaults.nlb`), not on the load balancer itself.
  const nlb = new LoadBalancer(mergeDefaults({
    Type: "network",
    Scheme: scheme,
    Subnets: props.subnetIds,
  }, defs?.nlb));

  // Target group. Static targets are optional — a `.map` keeps the `new`s
  // out of a conditional (EVL002).
  const targets = props.targets?.map((t) =>
    new TargetGroup_TargetDescription({
      Id: t.id,
      Port: t.port,
      AvailabilityZone: t.availabilityZone,
    }),
  );

  const targetGroup = new TargetGroup(mergeDefaults({
    TargetType: targetType,
    Protocol: protocol,
    Port: targetPort,
    VpcId: props.vpcId,
    HealthCheckProtocol: props.healthCheckProtocol ?? "TCP",
    HealthCheckPort: props.healthCheckPort,
    HealthCheckPath: props.healthCheckPath,
    Targets: targets,
  }, defs?.targetGroup));

  // Listener — forwards to the target group. TLS carries the cert; a
  // ternary keeps the `new` out of the `if` (EVL002).
  const forwardAction = new Listener_Action({
    Type: "forward",
    TargetGroupArn: targetGroup.TargetGroupArn,
  });

  const listenerProps: Record<string, unknown> = {
    LoadBalancerArn: nlb.LoadBalancerArn,
    Port: listenerPort,
    Protocol: protocol,
    DefaultActions: [forwardAction],
    Certificates:
      protocol === "TLS" && props.certificateArn
        ? [new Listener_Certificate({ CertificateArn: props.certificateArn })]
        : undefined,
  };

  const listener = new Listener(mergeDefaults(listenerProps, defs?.listener));

  return {
    nlb,
    targetGroup,
    listener,
  };
}, "NlbService");
