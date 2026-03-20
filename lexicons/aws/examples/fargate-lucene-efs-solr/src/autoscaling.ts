import {
  ScalableTarget,
  ApplicationAutoScalingScalingPolicy,
  ApplicationAutoScalingScalingPolicy_TargetTrackingScalingPolicyConfiguration,
  ApplicationAutoScalingScalingPolicy_PredefinedMetricSpecification,
  Join,
  Select,
  Split,
  Sub,
  Ref,
  AWS,
} from "@intentius/chant-lexicon-aws";
import { clusterArn, appName } from "./params";
import { solr } from "./solr";

const resourceId = Join("/", [
  "service",
  Select(1, Split("/", Ref(clusterArn))),
  solr.service.Name,
]);

export const scalableTarget = new ScalableTarget({
  ServiceNamespace: "ecs",
  ScalableDimension: "ecs:service:DesiredCount",
  ResourceId: resourceId,
  MinCapacity: 1,
  MaxCapacity: 6,
});

const predefinedMetric = new ApplicationAutoScalingScalingPolicy_PredefinedMetricSpecification({
  PredefinedMetricType: "ECSServiceAverageCPUUtilization",
});

const trackingConfig =
  new ApplicationAutoScalingScalingPolicy_TargetTrackingScalingPolicyConfiguration({
    TargetValue: 60,
    PredefinedMetricSpecification: predefinedMetric,
  });

export const scalingPolicy = new ApplicationAutoScalingScalingPolicy({
  PolicyName: Sub`${AWS.StackName}-${Ref(appName)}-cpu`,
  PolicyType: "TargetTrackingScaling",
  ServiceNamespace: "ecs",
  ScalableDimension: "ecs:service:DesiredCount",
  ResourceId: resourceId,
  TargetTrackingScalingPolicyConfiguration: trackingConfig,
});
