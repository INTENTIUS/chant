import { output } from "@intentius/chant-lexicon-aws";
import { productsTable, documentsBucket } from "./sources";

export const tableArns = output(productsTable.Arn, "TableArns");
export const bucketArns = output(documentsBucket.Arn, "BucketArns");
