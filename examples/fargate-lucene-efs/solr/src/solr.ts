import { SolrFargateService, EC2SecurityGroupIngress, Ref } from "@intentius/chant-lexicon-aws";
import {
  clusterArn,
  listenerArn,
  albSgId,
  executionRoleArn,
  vpcId,
  privateSubnet1,
  privateSubnet2,
  efsId,
  accessPointId,
  efsSecurityGroupId,
  solrImage,
  solrCollection,
} from "./params";

export const solr = SolrFargateService({
  clusterArn: Ref(clusterArn),
  listenerArn: Ref(listenerArn),
  albSecurityGroupId: Ref(albSgId),
  executionRoleArn: Ref(executionRoleArn),
  vpcId: Ref(vpcId),
  privateSubnetIds: [Ref(privateSubnet1), Ref(privateSubnet2)],
  image: Ref(solrImage),
  cpu: "1024",
  memory: "4096",
  desiredCount: 1,
  priority: 100,
  pathPatterns: ["/solr", "/solr/*"],
  command: ["solr-precreate", Ref(solrCollection)],
  efsMounts: [{ fileSystemId: Ref(efsId), accessPointId: Ref(accessPointId), containerPath: "/var/solr" }],
  autoscaling: { minCapacity: 1, maxCapacity: 6, cpuTarget: 60 },
});

// Allow the Fargate task to reach the EFS mount target on NFS port 2049.
// This is a cross-stack SecurityGroupIngress: the EFS SG is in the infra stack,
// the task SG is created above by FargateService.
export const efsAccessFromTask = new EC2SecurityGroupIngress({
  GroupId: Ref(efsSecurityGroupId),
  IpProtocol: "tcp",
  FromPort: 2049,
  ToPort: 2049,
  SourceSecurityGroupId: solr.taskSg.GroupId,
});
