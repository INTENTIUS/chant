// Plugin
export { slurmPlugin } from "./plugin";

// Serializer
export { slurmSerializer } from "./serializer";

// Conf resources (hand-written)
export { Cluster, Partition, Node, License, GresNode, CgroupConf, Switch } from "./conf/resources";
export type { ClusterProps, PartitionProps, NodeProps, LicenseProps, GresNodeProps, CgroupConfProps, SwitchProps } from "./conf/resources";

// Composites
export { GpuPartition } from "./composites/gpu-partition";
export type { GpuPartitionConfig, GpuPartitionResources } from "./composites/gpu-partition";
export { EDACluster } from "./composites/eda-cluster";
export type { EDAClusterConfig, EDAClusterResources, EDALicenseConfig } from "./composites/eda-cluster";
export { TrainingJob } from "./composites/training-job";
export type { TrainingJobConfig } from "./composites/training-job";

// Generated REST resources — re-exported from generated index
export { Job, Reservation, QoS } from "./generated/index";
