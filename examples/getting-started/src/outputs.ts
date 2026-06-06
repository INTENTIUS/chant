// A cross-resource reference.
//
// `app.bucket.Arn` points at another resource's attribute. chant resolves the
// reference during synthesis and emits the correct CloudFormation intrinsic in
// the output. Every value in the artifact traces back to a line of source.
import { output } from "@intentius/chant-lexicon-aws";
import { app } from "./main";

export const bucketArn = output(app.bucket.Arn, "DocsBucketArn");
