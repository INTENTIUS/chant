import {
  FargateService,
  TaskDefinition_Volume,
  TaskDefinition_EFSVolumeConfiguration,
  Ref,
} from "@intentius/chant-lexicon-aws";
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
  solrImage,
} from "./params";

const efsVolumeConfig = new TaskDefinition_EFSVolumeConfiguration({
  FileSystemId: efsId,
  AuthorizationConfig: { AccessPointId: accessPointId },
  TransitEncryption: "ENABLED",
});

const efsVolume = new TaskDefinition_Volume({
  Name: "solr-data",
  EFSVolumeConfiguration: efsVolumeConfig,
});

export const solr = FargateService({
  clusterArn: Ref(clusterArn),
  listenerArn: Ref(listenerArn),
  albSecurityGroupId: Ref(albSgId),
  executionRoleArn: Ref(executionRoleArn),
  vpcId: Ref(vpcId),
  privateSubnetIds: [Ref(privateSubnet1), Ref(privateSubnet2)],
  image: Ref(solrImage),
  containerPort: 8983,
  cpu: "1024",
  memory: "2048",
  desiredCount: 1,
  priority: 100,
  pathPatterns: ["/solr", "/solr/*"],
  healthCheckPath: "/solr/",
  environment: { SOLR_HEAP: "1g" },
  ManagedPolicyArns: [
    "arn:aws:iam::aws:policy/AmazonElasticFileSystemClientReadWriteAccess",
  ],
  defaults: {
    taskDef: {
      // EFS volume — container MountPoints (/var/solr → solr-data) would be
      // added here via ContainerDefinitions override in a production deployment
      Volumes: [efsVolume],
    },
  },
});
