import { Parameter } from "@intentius/chant-lexicon-aws";

export const appName = new Parameter("String", { description: "App name", defaultValue: "solr" });

// From infra stack outputs
export const clusterArn = new Parameter("String", { description: "ECS Cluster ARN" });
export const listenerArn = new Parameter("String", { description: "ALB Listener ARN" });
export const albSgId = new Parameter("String", { description: "ALB Security Group ID" });
export const executionRoleArn = new Parameter("String", { description: "Execution Role ARN" });
export const vpcId = new Parameter("String", { description: "VPC ID" });
export const privateSubnet1 = new Parameter("String", { description: "Private Subnet 1" });
export const privateSubnet2 = new Parameter("String", { description: "Private Subnet 2" });
export const efsId = new Parameter("String", { description: "EFS File System ID" });
export const accessPointId = new Parameter("String", { description: "EFS Access Point ID" });
export const albDnsName = new Parameter("String", { description: "ALB DNS Name" });

// Solr config
export const solrImage = new Parameter("String", {
  description: "Solr Docker image",
  defaultValue: "solr:9",
});
export const solrCollection = new Parameter("String", {
  description: "Solr collection name",
  defaultValue: "lucene",
});
