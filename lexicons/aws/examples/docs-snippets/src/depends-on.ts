import { Instance, DbCluster } from "@intentius/chant-lexicon-aws";

// DependsOn with a string logical name
export const appServer = new Instance(
  {
    ImageId: "ami-12345678",
    InstanceType: "t3.micro",
  },
  { DependsOn: ["dbCluster"] },
);

// DependsOn with a Declarable reference (resolved automatically)
export const dbCluster = new DbCluster({
  Engine: "aurora-postgresql",
  MasterUsername: "admin",
  MasterUserPassword: "changeme",
  StorageEncrypted: true,
});

export const dependentWorker = new Instance(
  {
    ImageId: "ami-12345678",
    InstanceType: "t3.micro",
  },
  { DependsOn: [dbCluster] },
);
