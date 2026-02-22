import { output } from "@intentius/chant-lexicon-aws";
import { dataBucket } from "./data-bucket";

export const dataBucketArn = output(dataBucket.Arn, "DataBucketArn");
