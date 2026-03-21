import { Parameter } from "@intentius/chant-lexicon-aws";

export const appName = new Parameter("String", {
  description: "App name",
  defaultValue: "solr",
});
export const solrUrl = new Parameter("String", {
  description: "Solr base URL (e.g. http://alb-dns/solr)",
});
export const solrCollection = new Parameter("String", {
  description: "Solr collection name",
  defaultValue: "lucene",
});

// Per config.dynamoDB entry
export const productsTableArn = new Parameter("String", {
  description: "products DynamoDB table ARN (leave blank to create)",
  defaultValue: "",
});
export const productsStreamArn = new Parameter("String", {
  description: "products DynamoDB stream ARN",
  defaultValue: "",
});

// Per config.s3 entry
export const documentsBucketName = new Parameter("String", {
  description: "documents S3 bucket name (leave blank to create)",
  defaultValue: "",
});
