/**
 * Stack outputs — exports the data bucket ARN for use by other stacks or scripts.
 */
import { output } from "@intentius/chant";
import { dataBucket } from "./data-bucket";

export const dataBucketArn = output(dataBucket.Arn, "DataBucketArn");
