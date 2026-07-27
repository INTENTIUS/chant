import { Apigwv2Route, Permission, Sub, AWS } from "@intentius/chant-lexicon-aws";
import { itemsApi, crudIntegration } from "./api";
import { crudFn } from "./fn";

export const getRoute = new Apigwv2Route({
  ApiId: itemsApi.ApiId,
  RouteKey: "GET /items/{id}",
  Target: Sub`integrations/${crudIntegration.IntegrationId}`,
});

export const postRoute = new Apigwv2Route({
  ApiId: itemsApi.ApiId,
  RouteKey: "POST /items",
  Target: Sub`integrations/${crudIntegration.IntegrationId}`,
});

export const putRoute = new Apigwv2Route({
  ApiId: itemsApi.ApiId,
  RouteKey: "PUT /items/{id}",
  Target: Sub`integrations/${crudIntegration.IntegrationId}`,
});

export const deleteRoute = new Apigwv2Route({
  ApiId: itemsApi.ApiId,
  RouteKey: "DELETE /items/{id}",
  Target: Sub`integrations/${crudIntegration.IntegrationId}`,
});

// What CDK's HttpLambdaIntegration implies: API Gateway may invoke the function.
export const apiInvokePermission = new Permission({
  FunctionName: crudFn.Arn,
  Action: "lambda:InvokeFunction",
  Principal: "apigateway.amazonaws.com",
  SourceArn: Sub`arn:${AWS.Partition}:execute-api:${AWS.Region}:${AWS.AccountId}:${itemsApi.ApiId}/*/*`,
});
