import { Parameter } from "@intentius/chant-lexicon-aws";
import { output } from "@intentius/chant";
import { dataBucket } from "./data-bucket";

export const environment = new Parameter("String", {
  description: "Deployment environment",
  defaultValue: "dev",
});

export const dataBucketArn = output(dataBucket.arn, "DataBucketArn");
