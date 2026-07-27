import { HttpApi, Apigwv2Integration, Apigwv2Stage, Sub, AWS } from "@intentius/chant-lexicon-aws";
import { crudFn } from "./fn";

// File split note: a resource reference inside an intrinsic (Sub) folds when it crosses
// a file boundary; routes.ts holds everything that embeds these resources in a Sub.
export const itemsApi = new HttpApi({
  Name: Sub`${AWS.StackName}-items-api`,
  ProtocolType: "HTTP",
});

export const crudIntegration = new Apigwv2Integration({
  ApiId: itemsApi.ApiId,
  IntegrationType: "AWS_PROXY",
  IntegrationUri: crudFn.Arn,
  PayloadFormatVersion: "2.0",
});

export const defaultStage = new Apigwv2Stage({
  ApiId: itemsApi.ApiId,
  StageName: "$default",
  AutoDeploy: true,
});
