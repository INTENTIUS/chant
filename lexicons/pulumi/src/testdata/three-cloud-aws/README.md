A stack export shaped like the aws member of behold's example-three-cloud: a
VPC, subnets, a security group, an ECS cluster and service, a role with its
policy attachment, an EKS node group that names a cluster another member
declares, and a Deployment whose pod runs as a ServiceAccount another member
declares. Values are resolved, as an export holds them. The role carries a
secret envelope and a password input, which the graph must not copy.
