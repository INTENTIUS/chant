import { output } from "@intentius/chant-lexicon-aws";
import { app } from "./main";

export const bucketArn = output(app.bucket.Arn, "BucketArn");
