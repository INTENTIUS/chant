import { Sub, AWS } from "@intentius/chant-lexicon-aws";
import { SecureApi } from "./lambda-api";

export const healthApi = SecureApi({
  name: Sub`${AWS.StackName}-health`,
  runtime: "nodejs20.x",
  handler: "index.handler",
  code: {
    zipFile: `exports.handler = async () => ({
      statusCode: 200,
      body: JSON.stringify({ status: 'healthy' })
    });`,
  },
});
