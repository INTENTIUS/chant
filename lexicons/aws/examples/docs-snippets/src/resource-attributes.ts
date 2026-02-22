import { Bucket, DbInstance, Instance } from "@intentius/chant-lexicon-aws";

// DeletionPolicy — protect data from accidental stack deletion
export const database = new DbInstance(
  {
    DBInstanceClass: "db.t3.micro",
    Engine: "postgres",
    MasterUsername: "admin",
    MasterUserPassword: "changeme",
  },
  { DeletionPolicy: "Snapshot", UpdateReplacePolicy: "Snapshot" },
);

// Condition — only create this resource when a condition is true
export const prodBucket = new Bucket(
  { BucketName: "prod-data" },
  { Condition: "IsProduction" },
);

// Metadata — attach cfn-init configuration to an EC2 instance
export const webServer = new Instance(
  {
    ImageId: "ami-12345678",
    InstanceType: "t3.micro",
  },
  {
    Metadata: {
      "AWS::CloudFormation::Init": {
        config: {
          packages: { yum: { httpd: [] } },
          services: { sysvinit: { httpd: { enabled: true, ensureRunning: true } } },
        },
      },
    },
    CreationPolicy: {
      ResourceSignal: { Timeout: "PT15M" },
    },
  },
);
