import * as _ from "./_";

export const environment = new _.Parameter("String", {
  description: "Deployment environment",
  defaultValue: "dev",
});

export const dataBucketArn = _.output(_.$.dataBucket.arn, "DataBucketArn");
