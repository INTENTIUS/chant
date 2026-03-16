import { Sub, AWS, Ref } from "@intentius/chant-lexicon-aws";
import { SecureApi } from "./lambda-api";
import { environment } from "./params";

export const healthApi = SecureApi({
  name: Sub`${AWS.StackName}-${Ref(environment)}-health`,
  runtime: "nodejs20.x",
  handler: "index.handler",
  code: {
    ZipFile: `exports.handler = async () => ({
      statusCode: 200,
      body: JSON.stringify({ status: 'healthy' })
    });`,
  },
});
