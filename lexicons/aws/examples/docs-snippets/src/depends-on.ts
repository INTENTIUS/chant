import { Instance, RDSDBCluster } from "@intentius/chant-lexicon-aws";

// DependsOn with a string logical name
export const appServer = new Instance(
  {
    ImageId: "ami-12345678",
    InstanceType: "t3.micro",
  },
  { DependsOn: ["DatabaseCluster"] },
);

// DependsOn with a Declarable reference (resolved automatically)
export const database = new RDSDBCluster({
  Engine: "aurora-postgresql",
  MasterUsername: "admin",
  MasterUserPassword: "changeme",
});

export const worker = new Instance(
  {
    ImageId: "ami-12345678",
    InstanceType: "t3.micro",
  },
  { DependsOn: [database] },
);
