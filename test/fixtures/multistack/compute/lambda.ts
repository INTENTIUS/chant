import { Function as LambdaFunction, Tag } from "@intentius/chant-lexicon-aws";
export const handler = new LambdaFunction({
  FunctionName: "multi-stack-handler",
  Runtime: "nodejs20.x",
  Handler: "index.handler",
  Code: { ZipFile: "exports.handler = async () => ({ statusCode: 200 });" },
  Tags: [new Tag({ Key: "Name", Value: "handler" })],
});
